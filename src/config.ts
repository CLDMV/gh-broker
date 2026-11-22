/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/config.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:30:36-08:00 (1794691836)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The daemon's half of the config split (design #175 §1's config.ts row): reading the file,
 * the host-only fields (listen, upstream, the secrets provider, all of config.otp) and their
 * validations. The library half — {@link parseConfigLib}, its {@link ConfigLib} type and
 * {@link indexTools} — lives in src/core/config.ts and is re-exported here so the old
 * import path keeps working.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Config, OtpConfig, SecretsConfig } from "./types.ts";
import { agentsDir } from "./agents.ts";

import { parseConfigLib, indexTools } from "./core/config.ts";

export { parseConfigLib, indexTools };
export type { ConfigLib } from "./core/config.ts";

/** Load and validate the JSON config. Throws with a precise message on any problem. */
export function loadConfig(path: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`config: cannot read/parse ${path}: ${(err as Error).message}`, { cause: err });
	}
	if (typeof raw !== "object" || raw === null) throw new Error("config: root must be an object");
	const c = raw as Record<string, unknown>;

	if (typeof c.listen === "string" && c.listen.startsWith("unix:")) {
		throw new Error(
			'config.listen: the shared "unix:" socket was replaced by one socket per agent; re-run the installer (sudo gh-broker install) to set listen to "agents:/run/gh-broker/agents"'
		);
	}
	if (typeof c.listen !== "string" || !agentsDir(c.listen)) {
		throw new Error('config.listen: must be "agents:<absolute directory>", e.g. "agents:/run/gh-broker/agents"');
	}
	if (typeof c.upstream !== "string" || !/^https?:\/\//.test(c.upstream)) {
		throw new Error("config.upstream: must be an http(s) URL");
	}

	// The lib fields validate in one pass (parseConfigLib); the two hooks drop the daemon-only
	// validations in at the exact points they run today, so a config invalid in several
	// sections reports the same error it always did.
	let secrets: SecretsConfig | undefined;
	let otp: OtpConfig | undefined;
	const lib = parseConfigLib(raw, {
		afterApp: () => {
			if (c.secrets !== undefined) secrets = parseSecretsConfig(c.secrets);
		},
		afterNpm: () => {
			otp = c.otp !== undefined ? parseOtpConfig(c.otp) : undefined;
		}
	});

	return {
		listen: c.listen,
		upstream: c.upstream,
		tools: lib.tools,
		owners: lib.owners,
		...(lib.app ? { app: lib.app } : {}),
		...(secrets ? { secrets } : {}),
		...(lib.defaultOwner ? { defaultOwner: lib.defaultOwner } : {}),
		...(lib.npm ? { npm: lib.npm } : {}),
		...(lib.ghcr !== undefined ? { ghcr: lib.ghcr } : {}),
		...(otp ? { otp } : {})
	};
}

/** Validate config.secrets: where the actual token values live (the daemon's provider selection). */
function parseSecretsConfig(raw: unknown): SecretsConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config.secrets: must be an object");
	const s = raw as Record<string, unknown>;
	if (s.provider !== undefined && s.provider !== "file" && s.provider !== "systemd-creds") {
		throw new Error('config.secrets.provider: must be "systemd-creds" or "file"');
	}
	// Reject an empty path: resolveSecretsPath treats a falsy explicit path as
	// "not provided" and falls back to env/default, so "" would be silently ignored.
	if (s.path !== undefined && (typeof s.path !== "string" || s.path.length === 0)) {
		throw new Error("config.secrets.path: must be a non-empty string");
	}
	// path only means anything to the file provider; the systemd-creds provider
	// (the default) reads $CREDENTIALS_DIRECTORY and would silently ignore it.
	// Reject the combination so an operator can't think a file path is in effect.
	if (s.path !== undefined && (s.provider ?? "systemd-creds") !== "file") {
		throw new Error('config.secrets.path is only used by the "file" provider — set provider to "file" or remove path');
	}
	return {
		...(s.provider === "file" || s.provider === "systemd-creds" ? { provider: s.provider } : {}),
		...(typeof s.path === "string" ? { path: s.path } : {})
	};
}

/** Validate config.otp. Every limit is a positive integer; omitted ones take the defaults. */
function parseOtpConfig(raw: unknown): OtpConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config.otp: must be an object");
	const o = raw as Record<string, unknown>;
	if (typeof o.seed !== "string" || !o.seed.startsWith("cred:")) throw new Error('config.otp.seed: must be a "cred:<name>" ref');
	const out: OtpConfig = { seed: o.seed };
	for (const key of ["windowSeconds", "maxFailures", "lockoutSeconds", "maxLockouts"] as const) {
		const v = o[key];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error(`config.otp.${key}: must be a positive integer`);
		// The lockout length becomes an ISO timestamp (`lockedUntil`); beyond ~8.64e12 s the
		// ms value leaves the Date range and toISOString throws. The lib-otp option set caps
		// it there too — bounding it here keeps the error naming the config key instead of an
		// OtpError from the gate's constructor at startup.
		if (key === "lockoutSeconds" && v > 8_640_000_000_000)
			throw new Error("config.otp.lockoutSeconds: must be at most 8640000000000 (the largest lockout that fits a Date)");
		out[key] = v;
	}
	if (o.statePath !== undefined) {
		if (typeof o.statePath !== "string" || !isAbsolute(o.statePath)) throw new Error("config.otp.statePath: must be an absolute path");
		out.statePath = o.statePath;
	}
	return out;
}
