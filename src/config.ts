import { readFileSync } from "node:fs";
import type { Config, Mode, ToolRule } from "./types.ts";

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

	if (typeof c.listen !== "string" || !c.listen.startsWith("unix:")) {
		throw new Error('config.listen: must be a "unix:<path>" string');
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
		seen.add(o.name);
		return { name: o.name, mode: o.mode as Mode, custom: o.custom === true };
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

	return { listen: c.listen, upstream: c.upstream, tools, owners, ...(app ? { app } : {}), ...(defaultOwner ? { defaultOwner } : {}) };
}

/** Build a name→rule index for O(1) allowlist checks. */
export function indexTools(tools: ToolRule[]): Map<string, ToolRule> {
	return new Map(tools.map((t) => [t.name, t]));
}
