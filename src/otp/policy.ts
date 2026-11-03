/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/policy.ts
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
 * Which tools need a broker OTP, and whether OTP is set up at all. Catalog, router and
 * availability all ask here, so the advertised schema, the availability check and the
 * gate itself can never disagree about a tool.
 */

import type { Config, OtpConfig, SecretStore, ToolRule } from "../types.ts";
import { base32Decode } from "./totp.ts";

/** The status verb. Never gated and never blocked by a lock, so a locked agent can still report. */
export const OTP_STATUS = "otp_status";

/** The argument a gated call carries its code in (npm_scaffold's own npm code is `npm_otp`). */
export const OTP_ARG = "otp";

/** Tools gated when config.tools[i].otp doesn't say otherwise. Empty for now (see #146). */
export const DEFAULT_GATED: ReadonlySet<string> = new Set<string>();

export const OTP_DEFAULTS = {
	windowSeconds: 300,
	maxFailures: 5,
	lockoutSeconds: 600,
	maxLockouts: 3,
	statePath: "/var/lib/gh-broker/otp-state.json"
} as const;

export type OtpSettings = Required<Omit<OtpConfig, "seed">>;

/** config.otp with every default filled in (defaults alone when there is no config.otp). */
export function otpSettings(config: Config): OtpSettings {
	const o = config.otp;
	return {
		windowSeconds: o?.windowSeconds ?? OTP_DEFAULTS.windowSeconds,
		maxFailures: o?.maxFailures ?? OTP_DEFAULTS.maxFailures,
		lockoutSeconds: o?.lockoutSeconds ?? OTP_DEFAULTS.lockoutSeconds,
		maxLockouts: o?.maxLockouts ?? OTP_DEFAULTS.maxLockouts,
		statePath: o?.statePath ?? OTP_DEFAULTS.statePath
	};
}

/** Whether `rule` needs a broker OTP: its own `otp` flag, else the built-in default. */
export function isGated(rule: ToolRule): boolean {
	if (rule.name === OTP_STATUS) return false;
	return rule.otp ?? DEFAULT_GATED.has(rule.name);
}

/** The decoded TOTP key, or why OTP isn't usable on this broker. */
export function readSeed(config: Config, secrets: SecretStore): { key: Buffer } | { problem: string } {
	if (!config.otp) return { problem: "OTP is not set up on this broker (no config.otp); re-run the installer to set it up" };
	const name = config.otp.seed.replace(/^cred:/, "");
	if (!secrets.has(config.otp.seed)) return { problem: `OTP is not set up on this broker: its seed credential "${name}" is not stored (re-run the installer to generate it)` };
	let key: Buffer;
	try {
		key = base32Decode(secrets.resolve(config.otp.seed).trim());
	} catch {
		key = Buffer.alloc(0);
	}
	if (key.length === 0) return { problem: `OTP is not set up on this broker: the stored seed "${name}" is not valid base32 (re-run the installer to replace it)` };
	return { key };
}

/** Why gated tools can't run on this broker, or undefined when OTP is ready. */
export function otpSetupProblem(config: Config, secrets: SecretStore): string | undefined {
	const seed = readSeed(config, secrets);
	return "problem" in seed ? seed.problem : undefined;
}
