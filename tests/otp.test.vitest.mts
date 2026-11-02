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
	const good = { version: 1, lastAcceptedStep: 7, failures: 2, lockedUntil: "2026-11-01T12:10:00.000Z", lockouts: ["2026-11-01T12:00:00.000Z"], hardLock: null };
	const file = (name: string, body?: string) => {
		const p = join(dir, name);
		if (body !== undefined) writeFileSync(p, body);
		return p;
	};

	it("starts all-zero", () => {
		expect(otp.emptyState()).toEqual({ version: 1, lastAcceptedStep: 0, failures: 0, lockedUntil: null, lockouts: [], hardLock: null });
	});

	it("validates the shape", () => {
		expect(otp.validState(good)).toBe(true);
		expect(otp.validState({ ...good, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: 3 } })).toBe(true);
		for (const bad of [
			null,
			[],
			{ ...good, version: 2 },
			{ ...good, lastAcceptedStep: "7" },
			{ ...good, failures: 1.5 },
			{ ...good, lockedUntil: "nope" },
			{ ...good, lockouts: "x" },
			{ ...good, lockouts: ["nope"] },
			{ ...good, hardLock: {} },
			{ ...good, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: "3" } }
		]) {
			expect(otp.validState(bad)).toBe(false);
		}
	});

	it("reads ok / missing / corrupt, and rethrows other read errors", () => {
		expect(otp.readState(file("ok.json", JSON.stringify(good)))).toEqual({ status: "ok", state: good });
		expect(otp.readState(join(dir, "nope.json"))).toEqual({ status: "missing", state: otp.emptyState() });
		expect(otp.readState(file("bad.json", "{not json")).status).toBe("corrupt");
		expect(otp.readState(file("shape.json", '{"version":1}')).status).toBe("corrupt");
		expect(() => otp.readState(dir)).toThrow(/EISDIR/);
	});

	it("unlock keeps only lastAcceptedStep", () => {
		expect(otp.unlockedState(good)).toEqual({ ...otp.emptyState(), lastAcceptedStep: 7 });
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

	it("overwrites an existing file", () => {
		const p = file("over.json", "garbage");
		otp.writeStateAtomic(p, good, { uid: 1, gid: 1 }, { chown: () => {} });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(good);
	});

	it("removes the temp file and rethrows when the chown fails", () => {
		const p = join(dir, "failed.json");
		expect(() =>
			otp.writeStateAtomic(p, good, { uid: 1, gid: 1 }, { chown: () => { throw new Error("EPERM"); } })
		).toThrow("EPERM");
		expect(existsSync(p)).toBe(false);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("uses chownSync by default (fails for a non-root test run, which is the point)", () => {
		const p = join(dir, "default.json");
		try {
			otp.writeStateAtomic(p, good, { uid: 0, gid: 0 });
		} catch {
			// not root: the default chown refused, and the temp file was cleaned up
		}
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
});

describe("describeState / formatStatus", () => {
	const now = Date.parse("2026-11-01T12:05:00.000Z");
	const base = otp.emptyState();

	it("reports an unlocked, missing state", () => {
		const d = otp.describeState({ status: "missing", state: base }, {}, now);
		expect(d).toMatchObject({ fileStatus: "missing", locked: false, failures: 0, maxFailures: 5, maxLockouts: 3, lockoutsLast24h: 0, lockedUntil: null });
		const lines = otp.formatStatus(d, { statePath: "/p", configured: true });
		expect(lines).toEqual(["OTP configured: yes", "state file: /p (missing)", "bad codes so far: 0 of 5", "short lockouts in the last 24 h: 0 of 3", "not locked"]);
	});

	it("reports a short lockout, and ignores an expired one and old lockouts", () => {
		const active = otp.describeState({ status: "ok", state: { ...base, failures: 1, lockedUntil: "2026-11-01T12:10:00.000Z", lockouts: ["2026-11-01T12:00:00.000Z", "2026-10-30T12:00:00.000Z"] } }, { maxFailures: 9, maxLockouts: 4 }, now);
		expect(active).toMatchObject({ locked: true, lockedUntil: "2026-11-01T12:10:00.000Z", lockoutsLast24h: 1, maxFailures: 9, maxLockouts: 4 });
		expect(otp.formatStatus(active, { statePath: "/p", configured: false }).join("\n")).toContain("short lockout until 2026-11-01T12:10:00.000Z");
		expect(otp.formatStatus(active, { statePath: "/p", configured: false })[0]).toContain("no (re-run the installer");
		const expired = otp.describeState({ status: "ok", state: { ...base, lockedUntil: "2026-11-01T12:00:00.000Z" } }, {}, now);
		expect(expired).toMatchObject({ locked: false, lockedUntil: null });
	});

	it("reports a hard lock", () => {
		const d = otp.describeState({ status: "ok", state: { ...base, hardLock: { since: "2026-11-01T11:00:00.000Z", lockouts: 3 } } }, {}, now);
		expect(d.locked).toBe(true);
		expect(otp.formatStatus(d, { statePath: "/p", configured: true }).join("\n")).toContain("HARD LOCK since 2026-11-01T11:00:00.000Z after 3 lockouts. Clear it with: sudo gh-broker otp unlock");
	});

	it("reports a corrupt file as locked", () => {
		const d = otp.describeState({ status: "corrupt", state: base }, {}, now);
		expect(d).toMatchObject({ fileStatus: "corrupt", locked: true, failures: null });
		expect(otp.formatStatus(d, { statePath: "/p", configured: true }).join("\n")).toContain("LOCKED: the state file is unreadable");
	});

	it("uses Date.now when no clock is given", () => {
		expect(otp.describeState({ status: "missing", state: base }).locked).toBe(false);
	});
});
