import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as otp from "../deploy/lib/otp.mjs";

let dir: string;
beforeAll(() => {
	mkdirSync(join(process.cwd(), "tmp", "agents"), { recursive: true });
	dir = mkdtempSync(join(process.cwd(), "tmp", "agents", "otp-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("base32 / seed", () => {
	it("matches the RFC 4648 vectors (no padding)", () => {
		const enc = (s: string) => otp.base32Encode(Buffer.from(s));
		expect(enc("")).toBe("");
		expect(enc("f")).toBe("MY");
		expect(enc("fo")).toBe("MZXQ");
		expect(enc("foo")).toBe("MZXW6");
		expect(enc("foob")).toBe("MZXW6YQ");
		expect(enc("fooba")).toBe("MZXW6YTB");
		expect(enc("foobar")).toBe("MZXW6YTBOI");
	});

	it("generates a 32-character seed from 20 random bytes", () => {
		const random = vi.fn(() => Buffer.alloc(20, 0xff));
		expect(otp.generateSeed(random)).toBe("7".repeat(32));
		expect(random).toHaveBeenCalledWith(20);
		expect(otp.generateSeed()).toMatch(/^[A-Z2-7]{32}$/);
	});

	it("builds the otpauth URI", () => {
		expect(otp.otpauthUri("ABC", "my host")).toBe("otpauth://totp/gh-broker:my%20host?secret=ABC&issuer=gh-broker&algorithm=SHA1&digits=6&period=30");
	});
});

describe("showSeed", () => {
	it("prints the QR, the key and the URI", async () => {
		const lines: string[] = [];
		await otp.showSeed({ seed: "ABCDEF", host: "h", log: (m: string) => lines.push(m), qr: async () => "QR1\nQR2" });
		const text = lines.join("\n");
		expect(text).toContain("  QR1\n  QR2");
		expect(text).toContain("key: ABCDEF");
		expect(text).toContain("uri: otpauth://totp/gh-broker:h?secret=ABCDEF");
		expect(text).toContain("otp rotate");
	});

	it("renders a real terminal QR by default", async () => {
		const qr = await otp.renderQr("otpauth://totp/x?secret=ABC");
		expect(qr.split("\n").length).toBeGreaterThan(5);
		const lines: string[] = [];
		await otp.showSeed({ seed: "ABCDEF", host: "h", log: (m: string) => lines.push(m) });
		expect(lines.length).toBeGreaterThan(10);
	});
});

describe("seed credential", () => {
	it("reads the name from the cred ref", () => {
		expect(otp.seedCredName({ otp: { seed: "cred:otp-seed" } })).toBe("otp-seed");
		expect(otp.seedCredName({ otp: { seed: "literal" } })).toBeUndefined();
		expect(otp.seedCredName({ otp: {} })).toBeUndefined();
		expect(otp.seedCredName({})).toBeUndefined();
		expect(otp.seedCredName(undefined)).toBeUndefined();
	});

	it("knows whether a seed is already stored in either backend", () => {
		expect(otp.seedExists({ name: "s", existingFile: { s: "x" }, credFileExists: () => false })).toBe(true);
		expect(otp.seedExists({ name: "s", existingFile: {}, credFileExists: (n: string) => n === "s" })).toBe(true);
		expect(otp.seedExists({ name: "s", existingFile: {}, credFileExists: () => false })).toBe(false);
	});

	function io(creds: string[] = []) {
		const calls: string[] = [];
		return {
			calls,
			io: {
				readSecretsFile: vi.fn(() => ({ a: "1" })),
				writeSecretsFile: vi.fn((p: string, v: unknown) => calls.push(`write ${p} ${JSON.stringify(v)}`)),
				removeFile: vi.fn((f: string) => calls.push(`rm ${f}`)),
				encrypt: vi.fn((n: string, v: string, f: string) => calls.push(`enc ${n} ${v} ${f}`)),
				listCreds: vi.fn(() => creds),
				writeDropin: vi.fn((names: string[], d: string) => calls.push(`dropin ${names.join(",")} ${d}`))
			}
		};
	}
	const paths = { secrets: "/s/secrets.json", credsDir: "/c/creds" };

	it("sets the key in the secrets file for the file backend", () => {
		const t = io();
		expect(otp.storeSeed({ config: { secrets: { provider: "file" } }, name: "otp-seed", seed: "SEED", paths, io: t.io })).toBe("file");
		expect(t.calls).toEqual(['write /s/secrets.json {"a":"1","otp-seed":"SEED"}']);
	});

	it("replaces the .cred and rewrites the drop-in for systemd-creds (default backend)", () => {
		const t = io(["b-read", "a-read"]);
		expect(otp.storeSeed({ config: {}, name: "otp-seed", seed: "SEED", paths, io: t.io })).toBe("systemd-creds");
		expect(t.calls).toEqual(["rm /c/creds/otp-seed.cred", "enc otp-seed SEED /c/creds/otp-seed.cred", "dropin a-read,b-read,otp-seed /c/creds"]);
	});
});

describe("state file", () => {
	const user = { failures: 2, lockedUntil: "2026-11-01T12:10:00.000Z", lockouts: ["2026-11-01T12:00:00.000Z"], hardLock: null };
	const good = { version: 1, lastAcceptedStep: 7, users: { repo: user, glmtest: otp.emptyUser() } };
	const file = (name: string, body?: string) => {
		const p = join(dir, name);
		if (body !== undefined) writeFileSync(p, body);
		return p;
	};

	it("starts all-zero", () => {
		expect(otp.emptyState()).toEqual({ version: 1, lastAcceptedStep: 0, users: {} });
		expect(otp.emptyUser()).toEqual({ failures: 0, lockedUntil: null, lockouts: [], hardLock: null });
		expect(otp.userOf(good, "nobody")).toEqual(otp.emptyUser());
		expect(otp.userOf(good, "repo")).toEqual(user);
	});

	it("validates the shape", () => {
		expect(otp.validState(good)).toBe(true);
		expect(otp.validState({ ...good, users: { repo: { ...user, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: 3 } } } })).toBe(true);
		for (const bad of [
			null,
			[],
			{ ...good, version: 2 },
			{ ...good, lastAcceptedStep: "7" },
			{ ...good, users: [] },
			{ ...good, users: { repo: null } },
			{ ...good, users: { repo: { ...user, failures: 1.5 } } },
			{ ...good, users: { repo: { ...user, lockedUntil: "nope" } } },
			{ ...good, users: { repo: { ...user, lockouts: "x" } } },
			{ ...good, users: { repo: { ...user, lockouts: ["nope"] } } },
			{ ...good, users: { repo: { ...user, hardLock: {} } } },
			{ ...good, users: { repo: { ...user, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: "3" } } } }
		]) {
			expect(otp.validState(bad)).toBe(false);
		}
	});

	it("reads ok / missing / corrupt, and rethrows other read errors", () => {
		expect(otp.readState(file("ok.json", JSON.stringify(good)))).toEqual({ status: "ok", state: good });
		expect(otp.readState(join(dir, "nope.json"))).toEqual({ status: "missing", state: otp.emptyState() });
		expect(otp.readState(file("bad.json", "{not json")).status).toBe("corrupt");
		expect(otp.readState(file("shape.json", '{"version":1}')).status).toBe("corrupt");
		expect(otp.readState(file("old.json", JSON.stringify({ version: 1, lastAcceptedStep: 0, failures: 0, lockedUntil: null, lockouts: [], hardLock: null }))).status).toBe("corrupt");
		expect(() => otp.readState(dir)).toThrow(/EISDIR/);
	});

	it("clears one user or every user, keeping lastAcceptedStep", () => {
		expect(otp.withoutUser(good, "repo")).toEqual({ version: 1, lastAcceptedStep: 7, users: { glmtest: otp.emptyUser() } });
		expect(otp.withoutUser(good, "nobody")).toEqual(good);
		expect(otp.withoutUsers(good)).toEqual({ version: 1, lastAcceptedStep: 7, users: {} });
		expect(good.users.repo).toEqual(user);
	});

	it("writes atomically as 0600, chowned, with no temp file left", () => {
		const p = join(dir, "written.json");
		const chown = vi.fn();
		otp.writeStateAtomic(p, otp.emptyState(), { uid: 11, gid: 22 }, { chown });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(otp.emptyState());
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(chown).toHaveBeenCalledWith(expect.stringContaining(".written.json."), 11, 22);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("writeFileAtomic honors the mode, and overwrites an existing file", () => {
		const p = file("over.json", "garbage");
		otp.writeFileAtomic(p, "new\n", { uid: 1, gid: 1, mode: 0o640 }, { chown: () => {} });
		expect(readFileSync(p, "utf8")).toBe("new\n");
		expect(statSync(p).mode & 0o777).toBe(0o640);
	});

	it("removes the temp file and rethrows when the chown fails", () => {
		const p = join(dir, "failed.json");
		expect(() => otp.writeFileAtomic(p, "x", { uid: 1, gid: 1 }, { chown: () => { throw new Error("EPERM"); } })).toThrow("EPERM");
		expect(existsSync(p)).toBe(false);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("uses chownSync by default (a non-root run refuses, and the temp file is cleaned up)", () => {
		const p = join(dir, "default.json");
		try {
			otp.writeFileAtomic(p, "x", { uid: 0, gid: 0 });
		} catch {
			// not root: the default chown refused
		}
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
});

describe("describeUsers / formatStatus", () => {
	const now = Date.parse("2026-11-01T12:05:00.000Z");
	const zero = otp.emptyUser();
	const state = (users: Record<string, unknown>) => ({ status: "ok", state: { version: 1, lastAcceptedStep: 0, users } });

	it("reports unlocked users, including registered ones with no entry", () => {
		const d = otp.describeUsers({ status: "missing", state: otp.emptyState() }, ["repo"], {}, now);
		expect(d).toEqual([expect.objectContaining({ user: "repo", locked: false, failures: 0, maxFailures: 5, maxLockouts: 3, lockoutsLast24h: 0, lockedUntil: null })]);
		const lines = otp.formatStatus(d, { statePath: "/p", fileStatus: "missing", configured: true });
		expect(lines).toEqual(["OTP configured: yes", "state file: /p (missing)", "repo:", "  bad codes so far: 0 of 5", "  short lockouts in the last 24 h: 0 of 3", "  not locked"]);
	});

	it("lists registered agents together with users only the file mentions, sorted", () => {
		const d = otp.describeUsers(state({ zed: zero, repo: zero }), ["repo", "amy"], {}, now);
		expect(d.map((u) => u.user)).toEqual(["amy", "repo", "zed"]);
		expect(otp.formatStatus([], { statePath: "/p", fileStatus: "ok", configured: false })).toContain("no agents registered");
	});

	it("reports a short lockout, and ignores an expired one and old lockouts", () => {
		const active = otp.describeUsers(state({ repo: { ...zero, failures: 1, lockedUntil: "2026-11-01T12:10:00.000Z", lockouts: ["2026-11-01T12:00:00.000Z", "2026-10-30T12:00:00.000Z"] } }), [], { maxFailures: 9, maxLockouts: 4 }, now);
		expect(active[0]).toMatchObject({ locked: true, lockedUntil: "2026-11-01T12:10:00.000Z", lockoutsLast24h: 1, maxFailures: 9, maxLockouts: 4 });
		const text = otp.formatStatus(active, { statePath: "/p", fileStatus: "ok", configured: false }).join("\n");
		expect(text).toContain("short lockout until 2026-11-01T12:10:00.000Z");
		expect(text).toContain("no (re-run the installer");
		const expired = otp.describeUsers(state({ repo: { ...zero, lockedUntil: "2026-11-01T12:00:00.000Z" } }), [], {}, now);
		expect(expired[0]).toMatchObject({ locked: false, lockedUntil: null });
	});

	it("reports a hard lock with the per-user unlock command", () => {
		const d = otp.describeUsers(state({ repo: { ...zero, hardLock: { since: "2026-11-01T11:00:00.000Z", lockouts: 3 } } }), [], {}, now);
		expect(d[0].locked).toBe(true);
		expect(otp.formatStatus(d, { statePath: "/p", fileStatus: "ok", configured: true }).join("\n")).toContain("HARD LOCK since 2026-11-01T11:00:00.000Z after 3 lockouts. Clear it with: sudo gh-broker otp unlock repo");
	});

	it("reports a corrupt file as locking every user", () => {
		const d = otp.describeUsers({ status: "corrupt", state: otp.emptyState() }, ["repo"], { maxFailures: 2, maxLockouts: 1 }, now);
		expect(d[0]).toMatchObject({ user: "repo", corrupt: true, locked: true, failures: null, maxFailures: 2, maxLockouts: 1 });
		const text = otp.formatStatus(d, { statePath: "/p", fileStatus: "corrupt", configured: true }).join("\n");
		expect(text).toContain("LOCKED: the state file is unreadable");
		expect(text).toContain("unlock --all");
		expect(text).toContain("locked (state file unreadable)");
		expect(otp.describeUsers({ status: "corrupt", state: otp.emptyState() }, ["repo"], {}, now)[0]).toMatchObject({ maxFailures: 5, maxLockouts: 3 });
	});

	it("uses Date.now when no clock is given", () => {
		expect(otp.describeUsers({ status: "missing", state: otp.emptyState() }, ["a"])[0].locked).toBe(false);
		expect(otp.describeUser(zero).locked).toBe(false);
	});
});
