/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/policy.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T14:53:38-08:00 (1794696818)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The daemon's half of the old otp/policy module (design #175 §1's split row): the
 * seed checks (whether OTP is set up at all — the catalog's availability and the gate's
 * readiness both ask here) and the state file's location. The gating half — OTP_STATUS,
 * OTP_ARG, DEFAULT_GATED, isGated, windowText — and the config-derived limit settings
 * (OTP_DEFAULTS without statePath, otpSettings) are library vocabulary in
 * src/core/otp-policy.ts and are re-exported/extended here so the old import path keeps
 * working with its full shape.
 */

import type { Config, SecretStore } from "../types.ts";
import { base32Decode } from "./totp.ts";
import { OTP_DEFAULTS as LIB_OTP_DEFAULTS, otpSettings as libOtpSettings, type OtpSettings as LibOtpSettings } from "../core/otp-policy.ts";

export { OTP_STATUS, OTP_ARG, DEFAULT_GATED, isGated, windowText } from "../core/otp-policy.ts";

/** The state file's default location — host knowledge, kept out of the library's settings shape (src/core/otp-policy.ts). */
export const DEFAULT_STATE_PATH = "/var/lib/gh-broker/otp-state.json";

/** The daemon's OTP limits with their defaults, plus the state file's location. */
export const OTP_DEFAULTS = { ...LIB_OTP_DEFAULTS, statePath: DEFAULT_STATE_PATH };

/** The library's limit settings plus the host's state path. */
export type OtpSettings = LibOtpSettings & { statePath: string };

/** config.otp with every default filled in (defaults alone when there is no config.otp). */
export function otpSettings(config: Config): OtpSettings {
	return { ...libOtpSettings(config), statePath: config.otp?.statePath ?? OTP_DEFAULTS.statePath };
}

/** The decoded TOTP key, or why OTP isn't usable on this broker. */
export function readSeed(config: Config, secrets: SecretStore): { key: Buffer } | { problem: string } {
	if (!config.otp) return { problem: "OTP is not set up on this broker (no config.otp); re-run the installer to set it up" };
	const name = config.otp.seed.replace(/^cred:/, "");
	if (!secrets.has(config.otp.seed))
		return {
			problem: `OTP is not set up on this broker: its seed credential "${name}" is not stored (re-run the installer to generate it)`
		};
	let key: Buffer;
	try {
		key = base32Decode(secrets.resolve(config.otp.seed).trim());
	} catch {
		key = Buffer.alloc(0);
	}
	if (key.length === 0)
		return {
			problem: `OTP is not set up on this broker: the stored seed "${name}" is not valid base32 (re-run the installer to replace it)`
		};
	return { key };
}

/** Why gated tools can't run on this broker, or undefined when OTP is ready. */
export function otpSetupProblem(config: Config, secrets: SecretStore): string | undefined {
	const seed = readSeed(config, secrets);
	return "problem" in seed ? seed.problem : undefined;
}
