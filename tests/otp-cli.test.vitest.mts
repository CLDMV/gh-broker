import { describe, it, expect, vi } from "vitest";
import { runCli, USAGE } from "../deploy/lib/otp-cli.mjs";
import { emptyState } from "../deploy/lib/otp.mjs";

const NOW = Date.parse("2026-11-01T12:05:00.000Z");
const config = { otp: { seed: "cred:otp-seed" } };

function deps(over: Record<string, unknown> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const d = {
		log: (m: string) => out.push(m),
		error: (m: string) => err.push(m),
		now: () => NOW,
		isRoot: () => true,
		host: () => "box",
		readConfig: () => config,
		readState: vi.fn(() => ({ status: "ok", state: emptyState() })),
		writeState: vi.fn(),
		newSeed: () => "NEWSEED",
		storeSeed: vi.fn(),
		restart: vi.fn(),
		qr: async () => "QR",
		...over
	};
	return { d, out, err };
}

describe("runCli dispatch", () => {
	it("prints usage for no command, -h, --help and help", async () => {
		for (const argv of [[], ["-h"], ["--help"], ["help"]]) {
			const { d, out } = deps();
			expect(await runCli(argv, d)).toBe(0);
			expect(out).toEqual([USAGE]);
		}
	});

	it("refuses an unknown command", async () => {
		for (const argv of [["otp"], ["otp", "frob"], ["frob", "unlock"]]) {
			const { d, err } = deps();
			expect(await runCli(argv, d)).toBe(2);
			expect(err[0]).toContain("unknown command");
		}
	});

	it("refuses to run unless root", async () => {
		const { d, err } = deps({ isRoot: () => false });
		expect(await runCli(["otp", "status"], d)).toBe(1);
		expect(err[0]).toContain("must run as root: sudo gh-broker otp status");
	});

	it("reports an unreadable config", async () => {
		const { d, err } = deps({ readConfig: () => { throw new Error("ENOENT"); } });
		expect(await runCli(["otp", "status"], d)).toBe(1);
		expect(err[0]).toContain("cannot read the broker config: ENOENT");
	});

	it("turns a command failure into an error and exit 1", async () => {
		const { d, err } = deps({ readState: () => { throw new Error("EACCES"); } });
		expect(await runCli(["otp", "status"], d)).toBe(1);
		expect(err[0]).toBe("gh-broker otp status: EACCES");
	});
});

describe("otp status", () => {
	it("prints text for the default state path and limits", async () => {
		const { d, out } = deps();
		expect(await runCli(["otp", "status"], d)).toBe(0);
		expect(d.readState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json");
		expect(out).toContain("OTP configured: yes");
		expect(out).toContain("not locked");
	});

	it("honors the configured state path and limits, and prints JSON on request", async () => {
		const cfg = { otp: { seed: "cred:otp-seed", statePath: "/x/state.json", maxFailures: 7, maxLockouts: 2 } };
		const { d, out } = deps({ readConfig: () => cfg, readState: vi.fn(() => ({ status: "ok", state: { ...emptyState(), failures: 3 } })) });
		expect(await runCli(["otp", "status", "--json"], d)).toBe(0);
		const j = JSON.parse(out[0]);
		expect(j).toMatchObject({ configured: true, statePath: "/x/state.json", failures: 3, maxFailures: 7, maxLockouts: 2, locked: false, unlockCommand: "sudo gh-broker otp unlock" });
	});

	it("reports a corrupt file as locked", async () => {
		const { d, out } = deps({ readState: () => ({ status: "corrupt", state: emptyState() }) });
		await runCli(["otp", "status"], d);
		expect(out.join("\n")).toContain("LOCKED");
	});

	it("says OTP is not configured when the config has no seed", async () => {
		const { d, out } = deps({ readConfig: () => ({}) });
		await runCli(["otp", "status"], d);
		expect(out[0]).toContain("no (re-run the installer");
	});
});

describe("otp unlock", () => {
	it("does nothing when there is no state file", async () => {
		const { d, out } = deps({ readState: () => ({ status: "missing", state: emptyState() }) });
		expect(await runCli(["otp", "unlock"], d)).toBe(0);
		expect(d.writeState).not.toHaveBeenCalled();
		expect(out[0]).toContain("nothing to unlock");
	});

	it("clears a hard lock and keeps lastAcceptedStep", async () => {
		const locked = { ...emptyState(), lastAcceptedStep: 9, failures: 2, lockouts: ["2026-11-01T12:00:00.000Z"], hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 3 } };
		const { d, out } = deps({ readState: () => ({ status: "ok", state: locked }) });
		expect(await runCli(["otp", "unlock"], d)).toBe(0);
		expect(d.writeState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json", { ...emptyState(), lastAcceptedStep: 9 });
		expect(out[0]).toBe("unlocked /var/lib/gh-broker/otp-state.json");
	});

	it("rewrites a corrupt file clean", async () => {
		const { d, out } = deps({ readState: () => ({ status: "corrupt", state: emptyState() }) });
		await runCli(["otp", "unlock"], d);
		expect(d.writeState).toHaveBeenCalledWith(expect.any(String), emptyState());
		expect(out[0]).toContain("rewrote the corrupt state file");
	});

	it("clears counters on a file that wasn't locked", async () => {
		const { d, out } = deps({ readState: () => ({ status: "ok", state: { ...emptyState(), failures: 2 } }) });
		await runCli(["otp", "unlock"], d);
		expect(out[0]).toContain("was not locked; counters cleared");
	});
});

describe("otp rotate", () => {
	it("stores, shows and restarts", async () => {
		const { d, out } = deps();
		expect(await runCli(["otp", "rotate"], d)).toBe(0);
		expect(d.storeSeed).toHaveBeenCalledWith(config, "otp-seed", "NEWSEED");
		expect(out.join("\n")).toContain("key: NEWSEED");
		expect(d.restart).toHaveBeenCalled();
		expect(out.at(-1)).toContain("service restarted");
	});

	it("generates a seed itself and renders a real QR when not injected", async () => {
		const { d, out } = deps({ newSeed: undefined, qr: undefined });
		expect(await runCli(["otp", "rotate"], d)).toBe(0);
		const key = out.find((l) => l.includes("key: "))!;
		expect(key).toMatch(/key: [A-Z2-7]{32}$/);
		expect(d.storeSeed).toHaveBeenCalledWith(config, "otp-seed", key.split("key: ")[1]);
	});

	it("refuses when OTP isn't configured, storing and restarting nothing", async () => {
		const { d, err } = deps({ readConfig: () => ({}) });
		expect(await runCli(["otp", "rotate"], d)).toBe(1);
		expect(err[0]).toContain("OTP is not configured");
		expect(d.storeSeed).not.toHaveBeenCalled();
		expect(d.restart).not.toHaveBeenCalled();
	});

	it("does not show the new seed when storing it fails", async () => {
		const { d, out, err } = deps({ storeSeed: () => { throw new Error("disk full"); } });
		expect(await runCli(["otp", "rotate"], d)).toBe(1);
		expect(out.join("\n")).not.toContain("NEWSEED");
		expect(err[0]).toContain("disk full");
	});
});
