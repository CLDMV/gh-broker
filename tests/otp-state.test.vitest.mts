import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OtpStateFile, emptyState, emptyUser, parseState, userState } from "../src/otp/state.ts";

const ROOT = join(process.cwd(), "tmp", "otp-state-tests");
let n = 0;
let dir: string;

beforeEach(() => {
	dir = join(ROOT, `case-${n++}`);
	mkdirSync(dir, { recursive: true });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const iso = "2026-11-01T00:00:00.000Z";

describe("parseState", () => {
	const user = { failures: 2, lockedUntil: iso, lockouts: [iso], hardLock: { since: iso, lockouts: 3 } };

	it("accepts the documented shape and ignores extra keys", () => {
		const s = { version: 1, lastAcceptedStep: 7, users: { repo: { ...user, extra: 1 }, glmtest: emptyUser() }, extra: true };
		expect(parseState(s)).toEqual({ version: 1, lastAcceptedStep: 7, users: { repo: user, glmtest: emptyUser() } });
	});

	const bad = (u: unknown) => ({ ...emptyState(), users: { repo: u } });
	it.each([
		["not an object", 5],
		["null", null],
		["an array", []],
		["wrong version", { ...emptyState(), version: 2 }],
		["negative step", { ...emptyState(), lastAcceptedStep: -1 }],
		["no users", { version: 1, lastAcceptedStep: 0 }],
		["users as an array", { ...emptyState(), users: [] }],
		["a user that isn't an object", bad(1)],
		["an invalid user name", { ...emptyState(), users: { "Bad Name": emptyUser() } }],
		["a __proto__ key", JSON.parse('{"version":1,"lastAcceptedStep":0,"users":{"__proto__":{"failures":0,"lockedUntil":null,"lockouts":[],"hardLock":null}}}')],
		["fractional failures", bad({ ...emptyUser(), failures: 1.5 })],
		["non-ISO lockedUntil", bad({ ...emptyUser(), lockedUntil: "soon" })],
		["missing lockedUntil", bad({ failures: 0, lockouts: [], hardLock: null })],
		["lockouts not an array", bad({ ...emptyUser(), lockouts: "x" })],
		["a bad lockout entry", bad({ ...emptyUser(), lockouts: [iso, "nope"] })],
		["missing hardLock", bad({ failures: 0, lockedUntil: null, lockouts: [] })],
		["hardLock not an object", bad({ ...emptyUser(), hardLock: "yes" })],
		["hardLock without since", bad({ ...emptyUser(), hardLock: { lockouts: 3 } })],
		["hardLock with a bad count", bad({ ...emptyUser(), hardLock: { since: iso, lockouts: "3" } })]
	])("rejects %s", (_label, raw) => {
		expect(parseState(raw)).toBeUndefined();
	});

	it("userState copies a user's entry, or gives zeros for an unknown one", () => {
		const state = { ...emptyState(), users: { repo: user } };
		const copy = userState(state, "repo");
		copy.lockouts.push("x");
		expect(state.users.repo.lockouts).toEqual([iso]);
		expect(userState(state, "glmtest")).toEqual(emptyUser());
		expect(userState(state, "__proto__")).toEqual(emptyUser());
	});
});

describe("OtpStateFile", () => {
	it("reads a missing file as the empty state", () => {
		const f = new OtpStateFile(join(dir, "state.json"));
		expect(f.read()).toEqual({ ok: true, state: emptyState() });
	});

	it("writes atomically with mode 0600, leaves no temp file, and reads back what it wrote", () => {
		const path = join(dir, "state.json");
		const f = new OtpStateFile(path);
		const state = { ...emptyState(), lastAcceptedStep: 42, users: { repo: { ...emptyUser(), lockouts: [iso] } } };
		f.write(state);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(state);
		expect(f.read()).toEqual({ ok: true, state });
		expect(new OtpStateFile(path).read()).toEqual({ ok: true, state });
	});

	it("after its own write, still notices a file put in place by someone else (the root CLI)", () => {
		const path = join(dir, "state.json");
		const f = new OtpStateFile(path);
		f.write({ ...emptyState(), lastAcceptedStep: 5 });
		expect(f.read()).toEqual({ ok: true, state: { ...emptyState(), lastAcceptedStep: 5 } }); // served from the cache
		writeFileSync(`${path}.cli`, JSON.stringify({ ...emptyState(), lastAcceptedStep: 6 }));
		renameSync(`${path}.cli`, path);
		expect(f.read()).toEqual({ ok: true, state: { ...emptyState(), lastAcceptedStep: 6 } });
	});

	it("serves the cached read while the file is unchanged and re-reads when it changes", () => {
		const path = join(dir, "state.json");
		writeFileSync(path, JSON.stringify({ ...emptyState(), lastAcceptedStep: 1 }));
		const f = new OtpStateFile(path);
		const first = f.read();
		expect(f.read()).toBe(first);
		// Same size, different content: the inode/mtime still differ after an atomic replace.
		writeFileSync(`${path}.new`, JSON.stringify({ ...emptyState(), lastAcceptedStep: 2 }));
		rmSync(path);
		writeFileSync(path, readFileSync(`${path}.new`));
		const second = f.read();
		expect(second).toEqual({ ok: true, state: { ...emptyState(), lastAcceptedStep: 2 } });
	});

	it("fails closed on an unparseable file, with the time it noticed and a log line", () => {
		const path = join(dir, "state.json");
		writeFileSync(path, "{ not json");
		const f = new OtpStateFile(path, () => Date.parse(iso));
		expect(f.read()).toEqual({ ok: false, since: iso });
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unreadable or corrupt .*failing closed/));
	});

	it("fails closed on a file with the wrong shape", () => {
		const path = join(dir, "state.json");
		writeFileSync(path, JSON.stringify({ version: 1 }));
		expect(new OtpStateFile(path).read().ok).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unexpected shape/));
	});

	it("fails closed when the path can't even be stat'ed (not ENOENT)", () => {
		writeFileSync(join(dir, "file"), "x");
		expect(new OtpStateFile(join(dir, "file", "state.json")).read().ok).toBe(false);
	});

	it("throws when the directory is missing, keeping the new state in memory", () => {
		const f = new OtpStateFile(join(dir, "missing", "state.json"));
		const state = { ...emptyState(), lastAcceptedStep: 3 };
		expect(() => f.write(state)).toThrow(/OTP state could not be saved to .*missing/);
		expect(f.read()).toEqual({ ok: true, state });
	});

	it("removes its temp file when the rename fails", () => {
		const path = join(dir, "state.json");
		mkdirSync(path);
		writeFileSync(join(path, "occupied"), "x");
		expect(() => new OtpStateFile(path).write(emptyState())).toThrow(/could not be saved/);
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it.skipIf(process.getuid?.() === 0)("still succeeds when the directory can't be opened for its fsync", () => {
		const path = join(dir, "state.json");
		chmodSync(dir, 0o300); // write + search, no read: files can be created and renamed, the dir can't be opened
		try {
			const f = new OtpStateFile(path);
			f.write({ ...emptyState(), lastAcceptedStep: 1 });
			expect(f.read()).toEqual({ ok: true, state: { ...emptyState(), lastAcceptedStep: 1 } });
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(JSON.parse(readFileSync(path, "utf8")).lastAcceptedStep).toBe(1);
	});
});
