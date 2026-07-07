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
		owners[owner.toLowerCase()] = { read: o.read, write: o.write };
	}
	if (Object.keys(owners).length === 0) throw new Error("config.owners: at least one owner required");

	return { listen: c.listen, upstream: c.upstream, tools, owners };
}

/** Build a name→rule index for O(1) allowlist checks. */
export function indexTools(tools: ToolRule[]): Map<string, ToolRule> {
	return new Map(tools.map((t) => [t.name, t]));
}
