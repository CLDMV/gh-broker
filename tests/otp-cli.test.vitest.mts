import { describe, it, expect, vi } from "vitest";
import { otpCommand } from "../deploy/lib/otp-cli.mjs";
import { emptyState, emptyUser } from "../deploy/lib/otp.mjs";
import { makeDeps, config, NOW } from "./helpers/cli-deps.mjs";

/** What a CLI write sets lastAcceptedStep to at NOW: every code up to one step ahead is spent. */
const STEP = Math.floor(NOW / 30000) + 1;

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

	it("clears one user's hard lock, leaves the others, spends recent codes and audits it", async () => {
		const other = { ...emptyUser(), failures: 1 };
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: hard, glmtest: other }) });
		expect(await otpCommand("unlock", ["repo"], config, d)).toBe(0);
		expect(d.writeState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json", { version: 1, lastAcceptedStep: STEP, users: { glmtest: other } });
		expect(out[0]).toBe("unlocked repo. The code the authenticator shows now won't work, nor the one after it: wait 60 s for a fresh code.");
		expect(d.audit).toHaveBeenCalledWith({ ts: new Date(NOW).toISOString(), decision: "otp-unlock", user: "repo", by: "admin" });
	});

	it("still unlocks when the journal write fails, with a warning; names root without a sudo user", async () => {
		const { d, err } = makeDeps({ readState: () => stateWith({ repo: hard }), sudoUser: () => undefined, audit: vi.fn(() => { throw new Error("systemd-cat: not found"); }) });
		expect(await otpCommand("unlock", ["repo"], config, d)).toBe(0);
		expect(d.writeState).toHaveBeenCalled();
		expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ by: "root" }));
		expect(err[0]).toBe("warning: the unlock could not be written to the journal: systemd-cat: not found");
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
		expect(d.writeState).toHaveBeenCalledWith(expect.any(String), { version: 1, lastAcceptedStep: STEP, users: {} });
		expect(out[0]).toContain("every user");
		expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ user: "*" }));
	});

	it("refuses a single-user unlock on a corrupt file, but --all rewrites it clean", async () => {
		const corrupt = () => ({ status: "corrupt", state: emptyState() });
		const one = makeDeps({ readState: corrupt });
		await expect(otpCommand("unlock", ["repo"], config, one.d)).rejects.toThrow(/corrupt, so every user is locked; run "sudo gh-broker otp unlock --all"/);
		expect(one.d.writeState).not.toHaveBeenCalled();
		const all = makeDeps({ readState: corrupt });
		await otpCommand("unlock", ["--all"], config, all.d);
		expect(all.d.writeState).toHaveBeenCalledWith(expect.any(String), { ...emptyState(), lastAcceptedStep: STEP });
		expect(all.out[0]).toContain("rewrote the corrupt state file");
		expect(all.d.audit).toHaveBeenCalledWith(expect.objectContaining({ user: "*", detail: "rewrote a corrupt state file" }));
	});
});

describe("otp list", () => {
	it("lists hard-locked and short-locked users with the command that clears each", async () => {
		const short = { ...emptyUser(), lockedUntil: "2026-11-01T12:15:00.000Z" };
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: hard, glmtest: short, other: emptyUser() }) });
		expect(await otpCommand("list", [], config, d)).toBe(0);
		expect(out).toEqual([
			"glmtest  locked until 2026-11-01T12:15:00.000Z  unlock: sudo gh-broker otp unlock glmtest",
			`repo  hard-locked since ${hard.hardLock.since} after ${hard.hardLock.lockouts} lockouts  unlock: sudo gh-broker otp unlock repo`
		]);
	});

	it("says when nobody is locked out, and reports a corrupt file as everyone locked", async () => {
		const none = makeDeps({ readState: () => stateWith({}) });
		await otpCommand("list", [], config, none.d);
		expect(none.out).toEqual(["nobody is locked out"]);
		const bad = makeDeps({ readState: () => ({ status: "corrupt", state: emptyState() }) });
		await otpCommand("list", [], config, bad.d);
		expect(bad.out[0]).toBe("glmtest  locked: /var/lib/gh-broker/otp-state.json is corrupt  unlock: sudo gh-broker otp unlock --all");
	});

	it("prints JSON with --json", async () => {
		const { d, out } = makeDeps({ readState: () => stateWith({ repo: hard }) });
		await otpCommand("list", ["--json"], config, d);
		const j = JSON.parse(out[0]);
		expect(j).toMatchObject({ fileStatus: "ok", locked: [{ user: "repo", corrupt: false, hardLock: hard.hardLock, lockedUntil: null, unlockCommand: "sudo gh-broker otp unlock repo" }] });
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

	it("shows the seed before storing it, and says it isn't in use when storing fails", async () => {
		const { d, out } = makeDeps({ storeSeed: () => { throw new Error("disk full"); } });
		await expect(otpCommand("rotate", [], config, d)).rejects.toThrow('storing the new seed failed (disk full); the key above is not in use and the old seed is still the stored one. Nothing was restarted; run "sudo gh-broker otp rotate" again');
		expect(out.join("\n")).toContain("key: NEWSEED");
		expect(d.restart).not.toHaveBeenCalled();
	});

	it("stores nothing when showing the seed fails", async () => {
		const { d } = makeDeps({ qr: async () => { throw new Error("tty gone"); } });
		await expect(otpCommand("rotate", [], config, d)).rejects.toThrow("tty gone");
		expect(d.storeSeed).not.toHaveBeenCalled();
	});
});
