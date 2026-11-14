/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tests/otp-state-store-pin.test.vitest.mts
 *	@Date: 2026-11-13T21:30:00-08:00 (1794706200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV>
 *	@Last modified time: 2026-11-14T07:40:00-08:00 (1794750000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OtpStateFile, emptyState, type LockStateStore } from "../src/otp/state.ts";

// Pin for the LockStateStore seam (design #175 §2d): the gate's persistence contract, which
// the equivalence depends on — after a write throws, read() serves the attempted state (with
// the in-memory counters it carried) until the file's signature changes.

const ROOT = join(process.cwd(), "tmp", "otp-state-store-pin-tests");
let n = 0;

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("the LockStateStore write-failure contract", () => {
	it("after a throw, read() serves the attempted state until the file's signature changes", () => {
		// The store's parent directory doesn't exist, so the temp-file open fails and the
		// write throws — that is the deterministic failure injection (no chmod needed).
		const dir = join(ROOT, `store-${n++}`);
		const path = join(dir, "missing", "state.json");
		const store: LockStateStore = new OtpStateFile(path);
		const attempted = { ...emptyState(), lastAcceptedStep: 7 };
		expect(() => store.write(attempted)).toThrow(/OTP state could not be saved/);
		// The counters the attempted state carried are served back, so a failed write never
		// resets a count or hands back a spent code.
		expect(store.read()).toEqual({ ok: true, state: attempted });

		// Until the signature changes: a file put in place AT THE STORE'S PATH is re-read.
		mkdirSync(join(dir, "missing"), { recursive: true });
		const next = { ...emptyState(), lastAcceptedStep: 9 };
		writeFileSync(`${path}.new`, JSON.stringify(next));
		renameSync(`${path}.new`, path);
		expect(store.read()).toEqual({ ok: true, state: next });
	});

	it.skipIf(process.getuid?.() === 0)("the attempted state is what a read sees, not the file's last good content", () => {
		const dir = join(ROOT, `stale-${n++}`);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "state.json");
		writeFileSync(path, JSON.stringify({ ...emptyState(), lastAcceptedStep: 1 }));
		const store: LockStateStore = new OtpStateFile(path);
		store.read(); // caches the on-disk state
		const attempted = { ...emptyState(), lastAcceptedStep: 42, users: { repo: { failures: 3, lockedUntil: null, lockouts: [], hardLock: null } } };
		// The injection: a read-only directory, so the temp-file open fails with EACCES.
		// (Verified on this box: chmod 0500 blocks the owner's writes despite the ACLs.)
		chmodSync(dir, 0o500);
		try {
			expect(() => store.write(attempted)).toThrow(/OTP state could not be saved/);
			expect(store.read()).toEqual({ ok: true, state: attempted });
			// The file itself is untouched by the failed write.
			expect(JSON.parse(readFileSync(path, "utf8")).lastAcceptedStep).toBe(1);
		} finally {
			// Restore so afterAll's rmSync can remove the tree.
			chmodSync(dir, 0o700);
		}
	});
});
