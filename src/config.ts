/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/config.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T21:27:13-08:00 (1793683633)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Config, Mode, OtpConfig, ToolRule } from "./types.ts";
import { parseGhcrConfig } from "./verbs/ghcr/config.ts";
import { OTP_STATUS } from "./otp/policy.ts";
import { agentsDir } from "./agents.ts";
import { deniedReason } from "./denylist.ts";

const MODES: readonly Mode[] = ["read", "write"];

/** Load and validate the JSON config. Throws with a precise message on any problem. */
export function loadConfig(path: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`config: cannot read/parse ${path}: ${(err as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null) throw new Error("config: root must be an object");
	const c = raw as Record<string, unknown>;

	if (typeof c.listen === "string" && c.listen.startsWith("unix:")) {
		throw new Error('config.listen: the shared "unix:" socket was replaced by one socket per agent; re-run the installer (sudo gh-broker install) to set listen to "agents:/run/gh-broker/agents"');
	}
	if (typeof c.listen !== "string" || !agentsDir(c.listen)) {
		throw new Error('config.listen: must be "agents:<absolute directory>", e.g. "agents:/run/gh-broker/agents"');
	}
	if (typeof c.upstream !== "string" || !/^https?:\/\//.test(c.upstream)) {
		throw new Error("config.upstream: must be an http(s) URL");
	}
	if (!Array.isArray(c.tools) || c.tools.length === 0) {
		throw new Error("config.tools: must be a non-empty array");
	}

	const seen = new Set<string>();
	const tools: ToolRule[] = c.tools.map((t, i) => {
		const o = t as Record<string, unknown>;
		if (typeof o.name !== "string" || !o.name) throw new Error(`config.tools[${i}].name: required`);
		if (!MODES.includes(o.mode as Mode)) throw new Error(`config.tools[${i}].mode: must be read|write`);
		if (seen.has(o.name)) throw new Error(`config.tools: duplicate tool "${o.name}"`);
		const denied = deniedReason(o.name);
		if (denied) throw new Error(`config.tools[${i}] ("${o.name}"): never allowed in gh-broker (${denied}); remove it from config.tools`);
		seen.add(o.name);
		const custom = o.custom === true;
		const augment = o.augment === true;
		if (custom && augment) throw new Error(`config.tools[${i}] ("${o.name}"): custom and augment are mutually exclusive`);
		if (o.otp !== undefined && typeof o.otp !== "boolean") throw new Error(`config.tools[${i}].otp: must be true or false`);
		if (o.enabled !== undefined && typeof o.enabled !== "boolean") throw new Error(`config.tools[${i}].enabled: must be true or false`);
		if (o.name === OTP_STATUS) {
			// otp_status has to keep working while everything else is locked, so it can't be gated.
			if (o.otp === true) throw new Error(`config.tools[${i}] ("${OTP_STATUS}"): can't be gated (otp: true)`);
			if (o.enabled === false) throw new Error(`config.tools[${i}] ("${OTP_STATUS}"): can't be disabled (enabled: false)`);
			if (!custom) throw new Error(`config.tools[${i}] ("${OTP_STATUS}"): must be custom: true`);
		}
		return { name: o.name, mode: o.mode as Mode, custom, augment, ...(typeof o.otp === "boolean" ? { otp: o.otp } : {}), ...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}) };
	});

	if (typeof c.owners !== "object" || c.owners === null) throw new Error("config.owners: must be an object");
	const owners: Config["owners"] = {};
	for (const [owner, v] of Object.entries(c.owners as Record<string, unknown>)) {
		const o = v as Record<string, unknown>;
		if (typeof o.read !== "string" || typeof o.write !== "string") {
			throw new Error(`config.owners.${owner}: needs "read" and "write" credential refs`);
		}
		if (o.installationId !== undefined && typeof o.installationId !== "number") {
			throw new Error(`config.owners.${owner}.installationId: must be a number`);
		}
		owners[owner.toLowerCase()] = {
			read: o.read,
			write: o.write,
			...(typeof o.installationId === "number" ? { installationId: o.installationId } : {})
		};
	}
	if (Object.keys(owners).length === 0) throw new Error("config.owners: at least one owner required");

	let defaultOwner: string | undefined;
	if (c.defaultOwner !== undefined) {
		if (typeof c.defaultOwner !== "string" || !c.defaultOwner) {
			throw new Error("config.defaultOwner: must be a non-empty string naming a configured owner");
		}
		defaultOwner = c.defaultOwner.toLowerCase();
		if (!owners[defaultOwner]) {
			throw new Error(`config.defaultOwner "${c.defaultOwner}" is not a key of config.owners`);
		}
	}

	let app: Config["app"];
	if (c.app !== undefined) {
		const a = c.app as Record<string, unknown>;
		if (typeof a.appId !== "number") throw new Error("config.app.appId: must be a number");
		if (typeof a.privateKey !== "string") throw new Error('config.app.privateKey: must be a "cred:<name>" ref');
		app = { appId: a.appId, privateKey: a.privateKey };
	}

	let secrets: Config["secrets"];
	if (c.secrets !== undefined) {
		if (typeof c.secrets !== "object" || c.secrets === null || Array.isArray(c.secrets)) throw new Error("config.secrets: must be an object");
		const s = c.secrets as Record<string, unknown>;
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
		secrets = {
			...(s.provider === "file" || s.provider === "systemd-creds" ? { provider: s.provider } : {}),
			...(typeof s.path === "string" ? { path: s.path } : {})
		};
	}

	let npm: Config["npm"];
	if (c.npm !== undefined) {
		if (typeof c.npm !== "object" || c.npm === null || Array.isArray(c.npm)) throw new Error("config.npm: must be an object");
		const n = c.npm as Record<string, unknown>;
		if (typeof n.token !== "string" || !n.token.startsWith("cred:")) throw new Error('config.npm.token: must be a "cred:<name>" ref');
		if (!Array.isArray(n.scopes) || n.scopes.length === 0) throw new Error('config.npm.scopes: must be a non-empty array of scopes, e.g. ["@cldmv"]');
		const scopes = n.scopes.map((s, i) => {
			if (typeof s !== "string" || !/^@[a-z0-9][a-z0-9._~-]*$/.test(s)) throw new Error(`config.npm.scopes[${i}]: must be a lowercase npm scope like "@cldmv"`);
			return s;
		});
		if (n.registry !== undefined && (typeof n.registry !== "string" || !/^https:\/\//.test(n.registry))) {
			throw new Error("config.npm.registry: must be an https URL");
		}
		if (n.tokenOrgs !== undefined && (!Array.isArray(n.tokenOrgs) || !n.tokenOrgs.every((o) => typeof o === "string" && /^[a-z0-9][a-z0-9._~-]*$/.test(o)))) {
			throw new Error('config.npm.tokenOrgs: must be an array of lowercase npm org names, e.g. ["cldmv"]');
		}
		npm = {
			token: n.token,
			scopes,
			...(typeof n.registry === "string" ? { registry: n.registry } : {}),
			...(Array.isArray(n.tokenOrgs) ? { tokenOrgs: n.tokenOrgs as string[] } : {})
		};
	}

	const otp = c.otp !== undefined ? parseOtpConfig(c.otp) : undefined;

	return {
		listen: c.listen,
		upstream: c.upstream,
		tools,
		owners,
		...(app ? { app } : {}),
		...(secrets ? { secrets } : {}),
		...(defaultOwner ? { defaultOwner } : {}),
		...(npm ? { npm } : {}),
		...(c.ghcr !== undefined ? { ghcr: parseGhcrConfig(c.ghcr) } : {}),
		...(otp ? { otp } : {})
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
		out[key] = v;
	}
	if (o.statePath !== undefined) {
		if (typeof o.statePath !== "string" || !isAbsolute(o.statePath)) throw new Error("config.otp.statePath: must be an absolute path");
		out.statePath = o.statePath;
	}
	return out;
}

/** Build a name→rule index for O(1) allowlist checks. */
export function indexTools(tools: ToolRule[]): Map<string, ToolRule> {
	return new Map(tools.map((t) => [t.name, t]));
}
