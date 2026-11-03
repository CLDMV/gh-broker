import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, hotp, matchStep, safeEqual, stepAt, totpAt } from "../src/otp/totp.ts";

// RFC 6238 appendix B: the SHA1 seed is the ASCII string "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC_SHA1_VECTORS: Array<[number, string]> = [
	[59, "94287082"],
	[1111111109, "07081804"],
	[1111111111, "14050471"],
	[1234567890, "89005924"],
	[2000000000, "69279037"],
	[20000000000, "65353130"]
];

describe("totp — RFC 6238 SHA1 test vectors", () => {
	for (const [seconds, code] of RFC_SHA1_VECTORS) {
		it(`T=${seconds} → ${code}`, () => {
			expect(totpAt(RFC_KEY, seconds * 1000, 8)).toBe(code);
		});
	}

	it("6-digit codes are the last 6 digits of the same truncation", () => {
		expect(totpAt(RFC_KEY, 59_000)).toBe("287082");
		expect(totpAt(RFC_KEY, 1111111109_000)).toBe("081804");
	});

	it("hotp matches RFC 4226 appendix D for the first counters", () => {
		expect([0, 1, 2, 3, 9].map((c) => hotp(RFC_KEY, c))).toEqual(["755224", "287082", "359152", "969429", "520489"]);
	});

	it("stepAt is floor(seconds / 30)", () => {
		expect(stepAt(0)).toBe(0);
		expect(stepAt(29_999)).toBe(0);
		expect(stepAt(30_000)).toBe(1);
	});
});

describe("base32 (RFC 4648)", () => {
	const vectors: Array<[string, string]> = [
		["", ""],
		["f", "MY"],
		["fo", "MZXQ"],
		["foo", "MZXW6"],
		["foob", "MZXW6YQ"],
		["fooba", "MZXW6YTB"],
		["foobar", "MZXW6YTBOI"]
	];
	for (const [plain, encoded] of vectors) {
		it(`"${plain}" ↔ "${encoded}"`, () => {
			expect(base32Encode(Buffer.from(plain))).toBe(encoded);
			expect(base32Decode(encoded).toString()).toBe(plain);
		});
	}

	it("encodes the RFC 6238 seed", () => {
		expect(base32Encode(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
	});

	it("decodes lowercase and tolerates trailing padding", () => {
		expect(base32Decode("mzxw6ytboi======").toString()).toBe("foobar");
	});

	it("rejects characters outside the alphabet", () => {
		expect(() => base32Decode("MZXW1")).toThrow(/invalid character/);
		expect(() => base32Decode("MZ=XW")).toThrow(/invalid character/);
	});
});

describe("matchStep", () => {
	const now = 1111111111_000;
	const step = stepAt(now);

	it("accepts the current step and one either side, returning the matched step", () => {
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step), now)).toBe(step);
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step - 1), now)).toBe(step - 1);
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step + 1), now)).toBe(step + 1);
	});

	it("rejects codes two steps away", () => {
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step - 2), now)).toBeUndefined();
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step + 2), now)).toBeUndefined();
	});

	it("rejects malformed codes without comparing", () => {
		const good = hotp(RFC_KEY, step);
		expect(matchStep(RFC_KEY, ` ${good}`, now)).toBeUndefined();
		expect(matchStep(RFC_KEY, good.slice(1), now)).toBeUndefined();
		expect(matchStep(RFC_KEY, "abcdef", now)).toBeUndefined();
		expect(matchStep(RFC_KEY, `${good}0`, now)).toBeUndefined();
	});

	it("supports other skews and digit counts", () => {
		expect(matchStep(RFC_KEY, hotp(RFC_KEY, step - 1), now, 0)).toBeUndefined();
		expect(matchStep(RFC_KEY, "14050471", now, 0, 8)).toBe(step);
	});
});

describe("safeEqual", () => {
	it("compares equal-length strings and never matches different lengths", () => {
		expect(safeEqual("123456", "123456")).toBe(true);
		expect(safeEqual("123456", "123457")).toBe(false);
		expect(safeEqual("123456", "1234567")).toBe(false);
	});
});
