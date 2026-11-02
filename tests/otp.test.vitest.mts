import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync, lstatSync } from "node:fs";
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
				rename: vi.fn((a: string, b: string) => calls.push(`mv ${a} ${b}`)),
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
		expect(t.calls).toEqual(["rm /c/creds/otp-seed.cred.new", "enc otp-seed SEED /c/creds/otp-seed.cred.new", "mv /c/creds/otp-seed.cred.new /c/creds/otp-seed.cred", "dropin a-read,b-read,otp-seed /c/creds"]);
	});

	it("keeps the old .cred when the encrypt fails", () => {
		const t = io();
		t.io.encrypt.mockImplementation(() => { throw new Error("tpm busy"); });
		expect(() => otp.storeSeed({ config: {}, name: "otp-seed", seed: "SEED", paths, io: t.io })).toThrow("tpm busy");
		expect(t.calls).toEqual(["rm /c/creds/otp-seed.cred.new"]);
		expect(t.io.rename).not.toHaveBeenCalled();
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

	it("spendRecentCodes marks every code up to one step ahead as spent, and never lowers the step", () => {
		const now = Date.parse("2026-11-01T12:05:10.000Z");
		const step = Math.floor(now / 30000);
		expect(otp.spendRecentCodes(otp.emptyState(), now).lastAcceptedStep).toBe(step + 1);
		expect(otp.spendRecentCodes({ ...otp.emptyState(), lastAcceptedStep: step + 5 }, now).lastAcceptedStep).toBe(step + 5);
	});

	it("secondsUntilFreshCode counts to the start of the step after next (31-60 s)", () => {
		expect(otp.secondsUntilFreshCode(Date.parse("2026-11-01T12:05:00.000Z"))).toBe(60);
		expect(otp.secondsUntilFreshCode(Date.parse("2026-11-01T12:05:29.500Z"))).toBe(31);
	});

	it("fileSignature is 'missing' for no file, changes with the file, and passes on other errors", () => {
		const p = join(dir, "sig.json");
		expect(otp.fileSignature(p)).toBe("missing");
		writeFileSync(p, "a");
		const one = otp.fileSignature(p);
		writeFileSync(p, "abc");
		expect(otp.fileSignature(p)).not.toBe(one);
		expect(() => otp.fileSignature(p, () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })).toThrow("EACCES");
	});

	it("stateStore writes when the file is unchanged since its read, including a file that was missing", () => {
		const p = join(dir, "store.json");
		const store = otp.stateStore({ uid: 1, gid: 1 }, { fchown: () => {} });
		expect(store.read(p).status).toBe("missing");
		store.write(p, { ...otp.emptyState(), lastAcceptedStep: 3 });
		store.write(p, { ...otp.emptyState(), lastAcceptedStep: 4 }); // its own write doesn't count as a change
		expect(store.read(p)).toEqual({ status: "ok", state: { ...otp.emptyState(), lastAcceptedStep: 4 } });
	});

	it("stateStore refuses to write over a change made after its read, and leaves no temp file", () => {
		const p = file("raced.json", JSON.stringify(good));
		const store = otp.stateStore({ uid: 1, gid: 1 }, { fchown: () => {} });
		store.read(p);
		const daemon = JSON.stringify({ ...good, lastAcceptedStep: 99 });
		writeFileSync(p, daemon);
		expect(() => store.write(p, otp.emptyState())).toThrow(/changed while this command ran.*run the command again/);
		expect(readFileSync(p, "utf8")).toBe(daemon);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("validates like the daemon: no negative counts and no user key that isn't an agent name", () => {
		const ok = { version: 1, lastAcceptedStep: 1, users: { repo: otp.emptyUser() } };
		expect(otp.validState(ok)).toBe(true);
		expect(otp.validState({ ...ok, lastAcceptedStep: -1 })).toBe(false);
		expect(otp.validState({ ...ok, users: { repo: { ...otp.emptyUser(), failures: -2 } } })).toBe(false);
		expect(otp.validState({ ...ok, users: { repo: { ...otp.emptyUser(), hardLock: { since: "2026-11-01T00:00:00Z", lockouts: -1 } } } })).toBe(false);
		expect(otp.validState({ ...ok, users: { "Not A Name": otp.emptyUser() } })).toBe(false);
		expect(otp.validState({ ...ok, users: { root: otp.emptyUser() } })).toBe(false);
	});

	it("userOf ignores inherited keys", () => {
		expect(otp.userOf(otp.emptyState(), "constructor")).toEqual(otp.emptyUser());
	});

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
		const fchown = vi.fn();
		otp.writeStateAtomic(p, otp.emptyState(), { uid: 11, gid: 22 }, { fchown });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(otp.emptyState());
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(fchown).toHaveBeenCalledWith(expect.any(Number), 11, 22);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("writeFileAtomic honors the mode, and overwrites an existing file", () => {
		const p = file("over.json", "garbage");
		otp.writeFileAtomic(p, "new\n", { uid: 1, gid: 1, mode: 0o640 }, { fchown: () => {} });
		expect(readFileSync(p, "utf8")).toBe("new\n");
		expect(statSync(p).mode & 0o777).toBe(0o640);
	});

	it("replaces a symlink at the path instead of writing through it, and uses a fresh random temp name", () => {
		const target = file("target.json", "untouched");
		const p = join(dir, "linked.json");
		symlinkSync(target, p);
		const fchown = vi.fn();
		otp.writeFileAtomic(p, "new\n", { uid: 1, gid: 1 }, { fchown });
		otp.writeFileAtomic(p, "again\n", { uid: 1, gid: 1 }, { fchown });
		expect(readFileSync(target, "utf8")).toBe("untouched");
		expect(lstatSync(p).isSymbolicLink()).toBe(false);
		expect(readFileSync(p, "utf8")).toBe("again\n");
	});

	it("never opens an existing temp file: a planted symlink makes the open fail, not write through it", () => {
		const target = file("victim.json", "keep");
		const fixed = Buffer.alloc(8, 0xab);
		const p = join(dir, "planted.json");
		const planted = join(dir, `.planted.json.${fixed.toString("hex")}.tmp`);
		symlinkSync(target, planted);
		expect(() => otp.writeFileAtomic(p, "x", { uid: 1, gid: 1 }, { fchown: () => {}, random: () => fixed })).toThrow(/EEXIST/);
		expect(readFileSync(target, "utf8")).toBe("keep");
		expect(existsSync(p)).toBe(false);
		rmSync(planted);
	});

	it("removes the temp file and rethrows when the chown fails", () => {
		const p = join(dir, "failed.json");
		expect(() => otp.writeFileAtomic(p, "x", { uid: 1, gid: 1 }, { fchown: () => { throw new Error("EPERM"); } })).toThrow("EPERM");
		expect(existsSync(p)).toBe(false);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("uses fchownSync by default (a non-root run refuses, and the temp file is cleaned up)", () => {
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
