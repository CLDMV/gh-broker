/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/config-merge.mjs
 *	@Date: 2026-09-06T10:05:35-07:00 (1788714335)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T21:30:45-08:00 (1793683845)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Build the deployed config from four layers, lowest to highest precedence:
 *
 *   1. example defaults  — config.example.json: `listen`, `upstream` and the `tools` allowlist.
 *   2. deployed config   — what is already on the host (the previous install's result).
 *   3. --config file     — an operator config file, same shape as the deployed config.
 *   4. CLI flags         — one flag per setting (--owner, --listen, --ghcr-owner, ...).
 *
 * Field-level rules, because the layers have different owners:
 *   - `tools` (the allowlist) is a SECURITY control and is always taken from the example, so a
 *     removal or tightening in an update applies and neither the deployed copy, a --config
 *     file nor a flag can widen it. A --config file that contains `tools` is refused. The one
 *     exception is each deployed tool's boolean `otp` and `enabled`, which carry onto the same
 *     tool in the new list (they never add a tool).
 *   - Everything else is operator data and the deployed copy wins over the example: `listen`,
 *     `upstream`, `defaultOwner`, `owners`, `ghcr`, `app`, `secrets`, `npm`, `otp`,
 *     `claudeConfigDirs` (each agent's extra Claude config folders, #163; layers add to it). The example ships
 *     none of the owner-specific ones, so a fresh install has no owners until the operator
 *     supplies one (--owner, --config, or the interactive prompt).
 *   - Layers 3 and 4 are merged on top of what is deployed rather than replacing it: scalars are
 *     replaced, `owners` and `ghcr.owners` are merged per owner (and per field within an owner),
 *     and the other blocks (`app`, `secrets`, `npm`, the `ghcr` scalars) are merged per field.
 *     An upgrade run without flags therefore keeps the deployed owners and `ghcr` untouched.
 *
 * The result is validated by the real loader (`--check`) before anything is deployed, and a
 * --config file may hold only `cred:` references, never token values.
 */
import { assertAgentName, DEFAULT_LISTEN } from "./agents.mjs";

export const DEFAULT_GHCR_DROP_DIR = "/srv/gh-broker/ghcr-drop";

const OPERATOR_KEYS = ["listen", "upstream", "defaultOwner", "owners", "app", "secrets", "npm", "ghcr", "otp", "claudeConfigDirs"];
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Shapes of live GitHub / npm tokens (classic, fine-grained, app, npm granular). */
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,})\b/;

export function mergeConfig(example, current) {
	if (!example || typeof example !== "object" || Array.isArray(example)) throw new Error("mergeConfig: example config must be an object");
	if (!current) return structuredClone(example);
	if (typeof current !== "object" || Array.isArray(current)) throw new Error("mergeConfig: current config must be an object");

	const out = structuredClone(example);

	// tools: the allowlist is authoritative from the example (already copied into out). The per-tool
	// settings the operator owns are `otp` (gate a tool or ungate it, #143) and `enabled` (turn a
	// shipped tool on or off, #146), so a boolean one on a deployed tool is carried onto the same
	// tool in the new list. It never adds a tool.
	const deployed = (Array.isArray(current.tools) ? current.tools : []).filter(isObject);
	for (const key of ["otp", "enabled"]) {
		const kept = new Map(deployed.filter((t) => typeof t[key] === "boolean").map((t) => [t.name, t[key]]));
		for (const t of out.tools ?? []) if (kept.has(t.name)) t[key] = kept.get(t.name);
	}

	// scalars: current wins when defined. An old `unix:` listen is the shared-socket form the
	// per-agent sockets replaced, so it is not carried over (buildConfig sets the new default).
	for (const k of ["listen", "upstream", "defaultOwner"]) {
		if (current[k] !== undefined && !(k === "listen" && String(current[k]).startsWith("unix:"))) out[k] = current[k];
	}

	// owners: operator data. Current entries win per owner; any the example ships are kept.
	out.owners = { ...(example.owners ?? {}), ...(current.owners ?? {}) };

	// optional blocks: current wins if present.
	for (const k of ["app", "secrets", "npm", "ghcr", "claudeConfigDirs"]) {
		if (current[k] !== undefined) out[k] = structuredClone(current[k]);
	}

	// otp: the example ships the default seed ref; the deployed block wins per field, so a
	// user's own limits or state path survive an upgrade and new default fields still arrive.
	if (current.otp !== undefined) out.otp = { ...(example.otp ?? {}), ...structuredClone(current.otp) };

	return out;
}

/**
 * Lay `overlay` (a --config file or the flags' config fragment) on top of `base`. `tools` in the
 * overlay is ignored here (readOperatorConfig refuses it earlier). Returns a new object.
 */
export function layerConfig(base, overlay) {
	const out = structuredClone(base);
	for (const k of ["listen", "upstream", "defaultOwner"]) {
		if (overlay[k] !== undefined) out[k] = overlay[k];
	}
	for (const k of ["app", "secrets", "npm", "otp"]) {
		if (overlay[k] !== undefined) out[k] = { ...(out[k] ?? {}), ...structuredClone(overlay[k]) };
	}
	if (overlay.owners !== undefined) {
		out.owners = { ...(out.owners ?? {}) };
		for (const [name, creds] of Object.entries(overlay.owners)) out.owners[name] = { ...(out.owners[name] ?? {}), ...creds };
	}
	if (overlay.claudeConfigDirs !== undefined) out.claudeConfigDirs = addClaudeConfigDirs(out.claudeConfigDirs, overlay.claudeConfigDirs);
	if (overlay.ghcr !== undefined) {
		const { owners: ghcrOwners, ...scalars } = overlay.ghcr;
		const merged = { ...(out.ghcr ?? {}), ...structuredClone(scalars) };
		if (ghcrOwners !== undefined) {
			merged.owners = { ...(merged.owners ?? {}) };
			for (const [name, o] of Object.entries(ghcrOwners)) merged.owners[name] = { ...(merged.owners[name] ?? {}), ...structuredClone(o) };
		}
		out.ghcr = merged;
	}
	return out;
}

/**
 * `claudeConfigDirs` with `more` added: per agent, the folders of both, each once. The result is
 * a new object; neither argument is changed.
 */
export function addClaudeConfigDirs(base, more) {
	const out = structuredClone(isObject(base) ? base : {});
	for (const [user, dirs] of Object.entries(more)) out[user] = [...new Set([...absoluteFolders(out[user]), ...absoluteFolders(dirs)])];
	return out;
}

/**
 * The absolute folder paths in one agent's saved list. The deployed config can be hand-edited, so
 * a string instead of a list, or a relative entry, yields nothing rather than odd folders.
 */
export function absoluteFolders(dirs) {
	return Array.isArray(dirs) ? dirs.filter((d) => typeof d === "string" && d.startsWith("/")) : [];
}

/** Throw unless `v` is { "<agent user>": ["/absolute/dir", ...] }. `where` names it in the message. */
export function checkClaudeConfigDirs(v, where) {
	if (!isObject(v)) throw new Error(`${where} must be an object of agent user -> list of folders`);
	for (const [user, dirs] of Object.entries(v)) {
		assertAgentName(user);
		if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string" && d.startsWith("/"))) throw new Error(`${where}.${user} must be a list of absolute paths`);
	}
	return v;
}

/** The config fragment the CLI flags describe (same shape as a config file), or {} when none were given. */
export function overlayFromFlags(opts) {
	const o = {};
	if (opts.listen !== undefined) o.listen = opts.listen;
	if (opts.upstream !== undefined) o.upstream = opts.upstream;
	if (opts.defaultOwner !== undefined) o.defaultOwner = opts.defaultOwner;
	for (const org of opts.owners ?? []) (o.owners ??= {})[org] = { read: `cred:${org}-read`, write: `cred:${org}-write` };
	for (const [org, id] of Object.entries(opts.installationIds ?? {})) ((o.owners ??= {})[org] ??= {}).installationId = id;
	if (opts.appId !== undefined) o.app = { appId: opts.appId, privateKey: `cred:${opts.appPrivateKey ?? "gh-app-key"}` };
	if (opts.secretsPath !== undefined) o.secrets = { path: opts.secretsPath };
	const g = {};
	if (opts.ghcrDropDir !== undefined) g.dropDir = opts.ghcrDropDir;
	if (opts.ghcrMaxArchiveBytes !== undefined) g.maxArchiveBytes = opts.ghcrMaxArchiveBytes;
	if (opts.protectReleaseTags !== undefined) g.protectReleaseTags = opts.protectReleaseTags;
	if (opts.ghcrOwner !== undefined) {
		g.owners = { [opts.ghcrOwner]: { username: opts.ghcrUsername, credential: `cred:${opts.ghcrOwner}-packages`, images: [...opts.ghcrImages] } };
	}
	if (Object.keys(g).length) o.ghcr = g;
	for (const { user, dir } of opts.claudeConfigs ?? []) ((o.claudeConfigDirs ??= {})[user] ??= []).push(dir);
	return o;
}

/**
 * Parse an operator --config file. It must be a JSON object in the deployed config's shape, with
 * no `tools` (the allowlist ships with the code), no unknown top-level keys and no token values.
 * `read` is the file reader (injected so the check is testable). Throws on any problem.
 */
export function readOperatorConfig(path, read) {
	let raw;
	try {
		raw = JSON.parse(read(path));
	} catch (err) {
		throw new Error(`--config: cannot read/parse ${path}: ${err.message}`);
	}
	if (!isObject(raw)) throw new Error(`--config: ${path} must be a JSON object`);
	if (raw.tools !== undefined) throw new Error("--config: `tools` is the shipped allowlist and cannot be set from a config file");
	const unknown = Object.keys(raw).filter((k) => !OPERATOR_KEYS.includes(k));
	if (unknown.length) throw new Error(`--config: unknown key(s) ${unknown.join(", ")} (allowed: ${OPERATOR_KEYS.join(", ")})`);
	if (raw.claudeConfigDirs !== undefined) checkClaudeConfigDirs(raw.claudeConfigDirs, "--config: claudeConfigDirs");
	const hit = findTokenShape(raw, "");
	if (hit) throw new Error(`--config: ${hit} looks like a token. The config holds only "cred:<name>" references; pass the token with --secret, --secrets-file or env`);
	return raw;
}

/** Path of the first string in `v` shaped like a token, or undefined. */
function findTokenShape(v, where) {
	if (typeof v === "string") return TOKEN_SHAPE.test(v) ? where : undefined;
	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) {
			const hit = findTokenShape(v[i], `${where}[${i}]`);
			if (hit) return hit;
		}
	} else if (isObject(v)) {
		for (const [k, x] of Object.entries(v)) {
			const hit = findTokenShape(x, where ? `${where}.${k}` : k);
			if (hit) return hit;
		}
	}
	return undefined;
}

/**
 * The full pipeline: example -> deployed -> --config file -> flags, then the first-install
 * fix-ups. Returns { config, notes }.
 *
 * @param {object} o
 * @param {object} o.example           parsed config.example.json
 * @param {object | null} o.current    the deployed config, or null on a first install
 * @param {object | undefined} o.file  a parsed operator --config file (see readOperatorConfig)
 * @param {object} o.opts              parsed installer flags
 * @param {boolean} o.nonInteractive
 * @param {(q: string) => Promise<string>} o.ask  visible prompt, used only when no owner exists
 */
export async function buildConfig({ example, current, file, opts, nonInteractive, ask }) {
	const notes = [];
	let config = mergeConfig(example, current);
	if (file) config = layerConfig(config, file);
	config = layerConfig(config, overlayFromFlags(opts));
	config.owners ??= {};
	if (typeof config.listen !== "string" || config.listen.startsWith("unix:")) {
		config.listen = DEFAULT_LISTEN;
		notes.push(`listen set to ${DEFAULT_LISTEN} (one socket per agent; the shared unix: socket is gone)`);
	}

	if (Object.keys(config.owners).length === 0) {
		if (nonInteractive) {
			throw new Error("no GitHub owner configured — pass --owner <org> (repeatable) or --config <file> with an owners block");
		}
		const name = (await ask("GitHub owner (user or org) the broker serves, e.g. your-org: ")).trim().toLowerCase();
		if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(name)) throw new Error(`"${name}" is not a valid GitHub owner name — or pass --owner <org>`);
		config.owners[name] = { read: `cred:${name}-read`, write: `cred:${name}-write` };
	}
	for (const [name, creds] of Object.entries(config.owners)) {
		if (typeof creds.read !== "string" || typeof creds.write !== "string") {
			throw new Error(`owner "${name}" has no credentials — add it with --owner ${name}, or give "read" and "write" cred refs in --config`);
		}
	}

	const names = Object.keys(config.owners);
	if (current === null && config.defaultOwner === undefined && names.length === 1) {
		config.defaultOwner = names[0];
		notes.push(`defaultOwner set to "${names[0]}" (the only owner); change it with --default-owner`);
	}

	if (config.ghcr && config.ghcr.dropDir === undefined) {
		config.ghcr.dropDir = DEFAULT_GHCR_DROP_DIR;
		notes.push(`ghcr.dropDir defaulted to ${DEFAULT_GHCR_DROP_DIR} (change it with --ghcr-drop-dir)`);
	}
	return { config, notes };
}

/**
 * The `secrets` block for the chosen provider. A `path` only belongs to the "file" provider, and
 * the loader refuses the combination, so refuse it here before any credential is written.
 */
export function secretsBlock(provider, existing) {
	if (existing?.path && provider !== "file") {
		throw new Error(`secrets.path (${existing.path}) is only used by the "file" provider — use --secrets-provider file, or drop the path`);
	}
	return { provider, ...(existing?.path ? { path: existing.path } : {}) };
}
