/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/totp.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-13T07:15:50-08:00 (1794582950)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step) and RFC 4648 base32. This moved to `@cldmv/lib-otp`
 * (design #175: the whole file left for the package); every symbol is re-exported from the
 * package's public surface at this old import path, so the daemon, the CLI and the tests
 * keep their import sites. The package's implementation is byte-compatible with the one
 * that lived here — same RFC 6238/4648 algorithms, same "base32: invalid character" error —
 * with one deliberate hardening: base32Decode rejects non-ASCII characters before
 * upper-casing (some non-ASCII letters upper-case into alphabet characters, e.g. ı → I,
 * which would otherwise silently accept a damaged seed).
 */

export { STEP_SECONDS, base32Decode, base32Encode, hotp, matchStep, safeEqual, stepAt, totpAt } from "@cldmv/lib-otp";
