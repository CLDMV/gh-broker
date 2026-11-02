import { describe, it, expect } from "vitest";
import { otpCommand } from "../deploy/lib/otp-cli.mjs";
import { emptyState, emptyUser } from "../deploy/lib/otp.mjs";
import { makeDeps, config } from "./helpers/cli-deps.mjs";

const stateWith = (users: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ status: "ok", state: { ...emptyState(), lastAcceptedStep: 9, users, ...over } });
const hard = { ...emptyUser(), failures: 2, lockouts: ["2026-11-01T12:00:00.000Z"], hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 3 } };

describe("otp status", () => {
	it("prints every registered agent, even with no state file", async () => {
		const { d, out } = makeDeps({ readState: () => ({ status: "missing", state: emptyState() }) });
		expect(await otpCommand("status", [], config, d)).toBe(0);
		expect(d.readState).not.toBe(undefined);
		expect(out).toContain("OTP configured: yes");
		expect(out).toContain("glmtest:");
		expect(out).toContain("repo:");
	});

	it("shows only the named user, and reads the default state path", async () => {
		const { d, out } = makeDeps();
		await otpCommand("status", ["repo"], config, d);
		expect(d.readState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json");
		expect(out).toContain("repo:");
		expect(out).not.toContain("glmtest:");
	});

	it("honors the configured state path and limits, and prints JSON on request", async () => {
		const cfg = { ...config, otp: { seed: "cred:otp-seed", statePath: "/x/state.json", maxFailures: 7, maxLockouts: 2 } };
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: { ...emptyUser(), failures: 3 } }) });
		await otpCommand("status", ["--json"], cfg, d);
		const j = JSON.parse(out[0]);
		expect(j).toMatchObject({ configured: true, statePath: "/x/state.json", fileStatus: "ok", unlockCommand: "sudo gh-broker otp unlock <user>" });
		expect(j.users.find((u: any) => u.user === "repo")).toMatchObject({ failures: 3, maxFailures: 7, maxLockouts: 2, locked: false });
	});

	it("reports a corrupt file as locking everyone, and says OTP isn't configured without a seed", async () => {
		const { d, out } = makeDeps({ readState: () => ({ status: "corrupt", state: emptyState() }) });
		await otpCommand("status", [], { listen: config.listen }, d);
		expect(out.join("\n")).toContain("LOCKED");
		expect(out[0]).toContain("no (re-run the installer");
	});

	it("warns on stderr when the package and the deployed version differ", async () => {
		const { d, err } = makeDeps({ versions: () => ({ pkg: "2.0.0", deployed: "1.0.0" }) });
		await otpCommand("status", [], config, d);
		expect(err[0]).toContain("run \"sudo gh-broker install\"");
	});
});

describe("otp unlock", () => {
	it("needs a user or --all, not both", async () => {
		const { d } = makeDeps();
		await expect(otpCommand("unlock", [], config, d)).rejects.toThrow(/name the agent to unlock/);
		await expect(otpCommand("unlock", ["repo", "--all"], config, d)).rejects.toThrow(/name the agent to unlock/);
		await expect(otpCommand("unlock", ["Bad Name"], config, d)).rejects.toThrow(/not a valid agent user name/);
	});

	it("does nothing when there is no state file", async () => {
		const { d, out } = makeDeps({ readState: () => ({ status: "missing", state: emptyState() }) });
		expect(await otpCommand("unlock", ["repo"], config, d)).toBe(0);
		expect(d.writeState).not.toHaveBeenCalled();
		expect(out[0]).toContain("nothing to unlock");
	});

	it("clears one user's hard lock and leaves the others and lastAcceptedStep alone", async () => {
		const other = { ...emptyUser(), failures: 1 };
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: hard, glmtest: other }) });
		expect(await otpCommand("unlock", ["repo"], config, d)).toBe(0);
		expect(d.writeState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json", { version: 1, lastAcceptedStep: 9, users: { glmtest: other } });
		expect(out[0]).toBe("unlocked repo");
	});

	it("clears counters for a user who isn't hard-locked, and skips a user with no entry", async () => {
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: { ...emptyUser(), failures: 2 } }) });
		await otpCommand("unlock", ["repo"], config, d);
		expect(out[0]).toContain("not hard-locked");
		const again = makeDeps({ readState: () => stateWith({}) });
		await otpCommand("unlock", ["repo"], config, again.d);
		expect(again.d.writeState).not.toHaveBeenCalled();
		expect(again.out[0]).toContain("has no lock state");
	});

	it("--all clears every user", async () => {
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: hard, glmtest: hard }) });
		await otpCommand("unlock", ["--all"], config, d);
		expect(d.writeState).toHaveBeenCalledWith(expect.any(String), { version: 1, lastAcceptedStep: 9, users: {} });
		expect(out[0]).toContain("every user");
	});

	it("refuses a single-user unlock on a corrupt file, but --all rewrites it clean", async () => {
		const corrupt = () => ({ status: "corrupt", state: emptyState() });
		const one = makeDeps({ readState: corrupt });
		await expect(otpCommand("unlock", ["repo"], config, one.d)).rejects.toThrow(/corrupt, so every user is locked; run "sudo gh-broker otp unlock --all"/);
		expect(one.d.writeState).not.toHaveBeenCalled();
		const all = makeDeps({ readState: corrupt });
		await otpCommand("unlock", ["--all"], config, all.d);
		expect(all.d.writeState).toHaveBeenCalledWith(expect.any(String), emptyState());
		expect(all.out[0]).toContain("rewrote the corrupt state file");
	});
});

describe("otp rotate", () => {
	it("stores, shows and restarts", async () => {
		const { d, out } = makeDeps();
		expect(await otpCommand("rotate", [], config, d)).toBe(0);
		expect(d.storeSeed).toHaveBeenCalledWith(config, "otp-seed", "NEWSEED");
		expect(out.join("\n")).toContain("key: NEWSEED");
		expect(d.restart).toHaveBeenCalled();
		expect(out.at(-1)).toContain("service restarted");
	});

	it("generates a seed itself and renders a real QR when not injected", async () => {
		const { d, out } = makeDeps({ newSeed: undefined, qr: undefined });
		await otpCommand("rotate", [], config, d);
		const key = out.find((l) => l.includes("key: "))!;
		expect(key).toMatch(/key: [A-Z2-7]{32}$/);
		expect(d.storeSeed).toHaveBeenCalledWith(config, "otp-seed", key.split("key: ")[1]);
	});

	it("refuses when OTP isn't configured, storing and restarting nothing", async () => {
		const { d } = makeDeps();
		await expect(otpCommand("rotate", [], {}, d)).rejects.toThrow(/OTP is not configured/);
		expect(d.storeSeed).not.toHaveBeenCalled();
		expect(d.restart).not.toHaveBeenCalled();
	});

	it("does not show the new seed when storing it fails", async () => {
		const { d, out } = makeDeps({ storeSeed: () => { throw new Error("disk full"); } });
		await expect(otpCommand("rotate", [], config, d)).rejects.toThrow("disk full");
		expect(out.join("\n")).not.toContain("NEWSEED");
	});
});
