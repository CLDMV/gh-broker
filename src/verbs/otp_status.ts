/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/otp_status.ts
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
 * Custom verb: otp_status — the OTP gate's state (src/otp/gate.ts status()). Takes no
 * arguments, needs no owner or PAT, and is never blocked by a lock, so a locked-out agent
 * can still tell the user what happened and which command clears it.
 */

/** JSON Schema advertised to the agent for otp_status. */
export const OTP_STATUS_SCHEMA = {
	type: "object" as const,
	additionalProperties: false,
	properties: {}
};

export const OTP_STATUS_DESCRIPTION =
	'Report the broker\'s OTP gate: whether OTP is set up, which tools need an "otp" code, how many windows are open and when the next one closes, bad codes so far, any short lockout, short lockouts in the last 24 h, and the hard lock (which blocks every other tool) with the command that clears it. Never shows a code or the seed. Works even while the broker is locked. Needs no owner.';
