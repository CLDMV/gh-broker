/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/mcp-config.mjs
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T09:12:00-08:00 (1793639520)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Writing an agent user's Claude Code MCP config (#143, contract v2). The broker's entry goes in
 * the top-level `mcpServers` of `<home>/.claude.json`; nothing else in that file is touched. The
 * pure functions build the entry, pick its key and edit the JSON text; `applyMcpConfig` and
 * `removeMcpConfig` do the file work (backup, atomic write that keeps the owner and mode, and a
 * read-back check) with every filesystem effect injected.
 */
import { agentGroup, socketPath } from "./agents.mjs";

export const MCP_FILE = ".claude.json";
export const MCP_BACKUP = ".claude.json.gh-broker.bak";
const BROKER_PATH = "/run/gh-broker/";

/** The entry for `user`. `sg` makes the new group effective without a re-login. */
export function mcpEntry(user, dir) {
	return { type: "stdio", command: "sg", args: [agentGroup(user), "-c", `exec socat STDIO UNIX-CONNECT:${socketPath(dir, user)}`] };
}

/** Whether an entry points at a broker socket: the standard /run/gh-broker/ tree, or the configured agents directory. */
const mentionsBroker = (entry, dir) => {
	const text = JSON.stringify(entry ?? null);
	return text.includes(BROKER_PATH) || (dir !== undefined && text.includes(`${dir}/`));
};
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys of the entries that point at the broker (any /run/gh-broker/ socket, old or new, or one in `dir`). */
export function brokerKeys(servers, dir) {
	return Object.keys(servers).filter((k) => mentionsBroker(servers[k], dir));
}

/** The key to write: the existing broker entry's, else `github`, `gh-broker`, then `gh-broker-<user>` (first free). */
export function chooseKey(servers, user, dir) {
	const existing = brokerKeys(servers, dir);
	if (existing.length) return existing[0];
	return ["github", "gh-broker", `gh-broker-${user}`].find((k) => !(k in servers)) ?? `gh-broker-${user}`;
}

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Indentation of the file as written (tab or n spaces), so the edit doesn't reformat it. */
function indentOf(text) {
	const m = /^\{\r?\n([ \t]+)\S/.exec(text);
	return m ? m[1] : "  ";
}

/** Parse the file; `undefined` text (no file) is an empty config. Returns undefined when it isn't a JSON object. */
function parse(text) {
	if (text === undefined) return {};
	try {
		const v = JSON.parse(text);
		return isObject(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the file's broker entry for `user` is "ok", "missing", "points elsewhere" or "unreadable". */
export function mcpStatus(text, user, dir) {
	const cfg = parse(text);
	if (cfg === undefined) return "unreadable";
	const servers = isObject(cfg.mcpServers) ? cfg.mcpServers : {};
	const keys = brokerKeys(servers, dir);
	if (keys.length === 0) return "missing";
	return keys.some((k) => sameEntry(servers[k], mcpEntry(user, dir))) ? "ok" : "points elsewhere";
}

/**
 * The file text with `user`'s entry set. Only the chosen key changes.
 * @returns {{ status: "unreadable" } | { status: "unchanged" | "changed", key: string, text: string }}
 */
export function mergeEntry(text, user, dir) {
	const cfg = parse(text);
	if (cfg === undefined) return { status: "unreadable" };
	const servers = isObject(cfg.mcpServers) ? cfg.mcpServers : {};
	const key = chooseKey(servers, user, dir);
	const entry = mcpEntry(user, dir);
	if (text !== undefined && sameEntry(servers[key], entry)) return { status: "unchanged", key, text };
	const next = { ...cfg, mcpServers: { ...servers, [key]: entry } };
	return { status: "changed", key, text: JSON.stringify(next, null, text === undefined ? "  " : indentOf(text)) + "\n" };
}

/**
 * The file text with every broker entry removed (an empty `mcpServers` is left in place).
 * @returns {{ status: "unreadable" | "absent" } | { status: "removed", keys: string[], text: string }}
 */
export function dropEntries(text, dir) {
	const cfg = parse(text);
	if (cfg === undefined) return { status: "unreadable" };
	const servers = isObject(cfg.mcpServers) ? cfg.mcpServers : {};
	const keys = brokerKeys(servers, dir);
	if (keys.length === 0) return { status: "absent" };
	const rest = Object.fromEntries(Object.entries(servers).filter(([k]) => !keys.includes(k)));
	return { status: "removed", keys, text: JSON.stringify({ ...cfg, mcpServers: rest }, null, indentOf(text)) + "\n" };
}

/**
 * Set `user`'s entry in their `.claude.json`.
 * @param {object} o
 * @param {string} o.home  the agent user's home directory
 * @param {string} o.user
 * @param {string} o.dir   the agents' socket directory
 * @param {{ uid: number, gid: number }} o.owner  owner for a file that has to be created
 * @param {object} io      { read(path) -> string | undefined, stat(path) -> { uid, gid, mode }, write(path, text, { uid, gid, mode }), join }
 * @returns {{ status: "created" | "written" | "unchanged" | "unreadable", key?: string, entry: object, path: string }}
 */
export function applyMcpConfig({ home, user, dir, owner }, io) {
	const path = `${home}/${MCP_FILE}`;
	const entry = mcpEntry(user, dir);
	const before = io.read(path);
	const merged = mergeEntry(before, user, dir);
	if (merged.status === "unreadable") return { status: "unreadable", entry, path };
	if (merged.status === "unchanged") return { status: "unchanged", key: merged.key, entry, path };
	let target = { ...owner, mode: 0o600 };
	if (before !== undefined) {
		const st = io.stat(path);
		target = { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
		io.write(`${home}/${MCP_BACKUP}`, before, target);
	}
	io.write(path, merged.text, target);
	if (mcpStatus(io.read(path), user, dir) !== "ok") throw new Error(`${path}: the broker entry is not there after writing; restore ${MCP_BACKUP} if the file looks wrong`);
	return { status: before === undefined ? "created" : "written", key: merged.key, entry, path };
}

/**
 * Remove the broker entry from `user`'s `.claude.json`, backing the file up first.
 * @returns {{ status: "removed" | "absent" | "no-file" | "unreadable", keys?: string[], path: string }}
 */
export function removeMcpConfig({ home, dir }, io) {
	const path = `${home}/${MCP_FILE}`;
	const before = io.read(path);
	if (before === undefined) return { status: "no-file", path };
	const dropped = dropEntries(before, dir);
	if (dropped.status !== "removed") return { status: dropped.status, path };
	const st = io.stat(path);
	const target = { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
	io.write(`${home}/${MCP_BACKUP}`, before, target);
	io.write(path, dropped.text, target);
	return { status: "removed", keys: dropped.keys, path };
}
