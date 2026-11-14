import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OtpGate } from "../src/otp/gate.ts";
import { OtpError } from "@cldmv/lib-otp";
import { base32Encode, totpAt } from "../src/otp/totp.ts";

// Pin for design #175 §5.13: gate.authorize passes the STORED SEED STRING to the
// package's verifyCode, which decodes it and throws the typed OTP_SEED_INVALID on a bad
// seed. The old decode→encode round-trip hid behind an unchecked cast
// `(readSeed(...) as { key: Buffer }).key`, so an invalid seed escaped authorize as a
// raw TypeError — unaudited, untyped. For a valid seed the behavior is identical: the
// package decodes the same base32 the old round-trip produced.

const KEY = Buffer.from("12345678901234567890", "ascii");
const SEED = base32Encode(KEY);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const TOOL = "merge_pull_request";

const ROOT = join(process.cwd(), "tmp", "otp-seed-pin-tests");
let n = 0;

function gateWith(seed: string) {
	const dir = join(ROOT, `case-${n++}`);
	mkdirSync(dir, { recursive: true });
	const config: any = {
		listen: "agents:/run/gh-broker/agents",
		upstream: "https://api.githubcopilot.com/mcp/",
		owners: { cldmv: { read: "cred:r", write: "cred:w" } },
		tools: [{ name: TOOL, mode: "write", otp: true }],
		otp: { seed: "cred:otp-seed", statePath: join(dir, "state.json") }
	};
	const secrets = { has: vi.fn(() => true), resolve: vi.fn(() => seed) };
	return new OtpGate(config, secrets as any, { now: () => T0, host: "box" });
}

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("the OTP gate reads the stored seed directly (§5.13)", () => {
	it("throws the typed OTP_SEED_INVALID on an invalid stored seed — never a raw TypeError", () => {
		const gate = gateWith("not base32!!");
		let err: unknown;
		try {
			gate.authorize(TOOL, "123456", "repo");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(OtpError);
		expect((err as OtpError).code).toBe("OTP_SEED_INVALID");
	});

	it("throws the typed OTP_SEED_INVALID on an empty-ish stored seed too", () => {
		const gate = gateWith("");
		expect(() => gate.authorize(TOOL, "123456", "repo")).toThrow(OtpError);
	});

	it("behaves identically for a valid seed: a current code opens a window", () => {
		const gate = gateWith(SEED);
		const audit = gate.authorize(TOOL, totpAt(KEY, T0), "repo");
		expect(audit.otp).toBe("opened");
		expect(audit.until).toBe(new Date(T0 + 300_000).toISOString());
		expect(typeof audit.window).toBe("string");
	});

	it("behaves identically for a valid seed in non-canonical base32 (case the old round-trip normalized)", () => {
		const gate = gateWith(SEED.toLowerCase());
		const audit = gate.authorize(TOOL, totpAt(KEY, T0), "repo");
		expect(audit.otp).toBe("opened");
	});
});
