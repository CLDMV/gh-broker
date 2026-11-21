/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/config.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:02:47-08:00 (1794697367)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Config, Mode, ToolRule } from "./types.ts";
import { parseGhcrConfig } from "./verbs/ghcr/config.ts";
import { OTP_STATUS } from "./otp-policy.ts";
import { deniedReason } from "./denylist.ts";

const MODES: readonly Mode[] = ["read", "write"];

/**
 * The library half of a parsed config: everything {@link parseConfigLib} validates. The
 * daemon-only fields — listen, upstream, the secrets provider and all of config.otp — are
 * the host's (see {@link loadConfig}).
 */
export type ConfigLib = Omit<Config, "listen" | "upstream" | "secrets" | "otp">;

/**
 * Validate the library half of a config: tools, owners, defaultOwner, app, npm and ghcr —
 * the pure-data fields, with every error prefixed `config.<field>:` exactly as
 * {@link loadConfig} reports it. The daemon-only fields (listen, upstream, the secrets
 * provider and all of config.otp) are the host's. `host` is how {@link loadConfig} keeps
 * today's validation order: its `afterApp` hook runs where config.secrets is validated and
 * its `afterNpm` hook where config.otp is, so a config invalid in several sections reports
 * the same error it always did. Library callers omit `host` and get the lib fields in one
 * pass, in the order tools, owners, defaultOwner, app, npm, ghcr.
 */
export function parseConfigLib(raw: unknown, host: { afterApp?: () => void; afterNpm?: () => void } = {}): ConfigLib {
	if (typeof raw !== "object" || raw === null) throw new Error("config: root must be an object");
	const c = raw as Record<string, unknown>;

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

	host.afterApp?.();

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

	host.afterNpm?.();

	return {
		tools,
		owners,
		...(app ? { app } : {}),
		...(defaultOwner ? { defaultOwner } : {}),
		...(npm ? { npm } : {}),
		...(c.ghcr !== undefined ? { ghcr: parseGhcrConfig(c.ghcr) } : {})
	};
}

/** Build a name→rule index for O(1) allowlist checks. Lives in the router core (the invoke
 * surface needs it); re-exported so this module's consumers keep one import path. */
export { indexTools } from "./router-core.ts";
