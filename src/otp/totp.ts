/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/totp.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T20:43:25-08:00 (1793594605)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step) and RFC 4648 base32, on node:crypto only.
 * The broker's codes are 6 digits; the digit count is a parameter so the RFC's own
 * 8-digit test vectors can check the implementation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** TOTP time step, in seconds. */
export const STEP_SECONDS = 30;

/** Encode bytes as unpadded RFC 4648 base32. */
export function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/**
 * Decode RFC 4648 base32. Case-insensitive; trailing "=" padding is tolerated. Throws on
 * any other character, so a damaged seed is reported instead of silently producing
 * codes nobody's authenticator can match.
 */
export function base32Decode(text: string): Buffer {
	const clean = text.toUpperCase().replace(/=+$/, "");
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error("base32: invalid character");
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** RFC 4226 HOTP for one counter value, zero-padded to `digits`. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac("sha1", key).update(msg).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
	return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The TOTP time step that contains `nowMs`. */
export function stepAt(nowMs: number): number {
	return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The TOTP code for the step containing `nowMs`. */
export function totpAt(key: Buffer, nowMs: number, digits = 6): string {
	return hotp(key, stepAt(nowMs), digits);
}

/** Constant-time string comparison; strings of different lengths never match. */
export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The step a code is valid for at `nowMs`, accepting `skew` steps either side, or
 * undefined when it matches none. Every candidate step is compared (no early exit), and
 * each comparison is constant-time. A malformed code (not exactly `digits` digits) never
 * matches.
 */
export function matchStep(key: Buffer, code: string, nowMs: number, skew = 1, digits = 6): number | undefined {
	if (!new RegExp(`^\\d{${digits}}$`).test(code)) return undefined;
	const now = stepAt(nowMs);
	let matched: number | undefined;
	for (let step = now - skew; step <= now + skew; step++) {
		if (safeEqual(hotp(key, step, digits), code)) matched = step;
	}
	return matched;
}
