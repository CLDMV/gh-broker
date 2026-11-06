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
 * the top-level `mcpServers` of `<home>/.claude.json`, and of the `.claude.json` in each other
 * Claude config folder the user has (#163: a session started with `CLAUDE_CONFIG_DIR` reads only
 * that folder's file); nothing else in those files is touched. The
 * pure functions build the entry, pick its key and edit the JSON text; `applyMcpConfig` and
 * `removeMcpConfig` do the file work (backup, atomic write that keeps the owner and mode, and a
 * read-back check) with every filesystem effect injected. Root does that work in a directory the
 * agent user owns, so `readOwnedFile` refuses anything but the user's own plain file.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { agentGroup, socketPath } from "./agents.mjs";

export const MCP_FILE = ".claude.json";
export const MCP_BACKUP = ".claude.json.gh-broker.bak";
const BROKER_PATH = "/run/gh-broker/";

/** Largest ~/.claude.json root will read (Claude Code's own file is far smaller). */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

/** A file root must not read or replace: a symlink, not a regular file, not the user's, hard-linked, or oversized. */
export class UnsafeFile extends Error {}

/** A config folder root won't work in (a symlink, not the agent's, outside the agent's home). It is skipped with a warning, not an error. */
export class SkippedFolder extends Error {}

/** Most of `/proc/<pid>/cmdline` read (only argv[0] and argv[1] are looked at). */
export const MAX_CMDLINE_BYTES = 64 * 1024;
/** Most of `/proc/<pid>/environ` read: the agent sets its own environment's size, and root reads it. */
export const MAX_ENVIRON_BYTES = 1024 * 1024;

/** Up to `max` bytes of `path`. */
export function readHead(path, max) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const buf = Buffer.alloc(max);
		let length = 0;
		for (let n; length < max && (n = readSync(fd, buf, length, max - length, null)) > 0; ) length += n;
		return buf.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

/** Whether a process's argv is a Claude Code session: the `claude` binary, or node running the claude-code package. */
const isClaude = (argv) => argv.slice(0, 2).some((a) => basename(a) === "claude" || a.includes("/@anthropic-ai/claude-code/"));

/**
 * Read `path` as root on behalf of the user `uid`, without following a symlink: the file must be
 * a regular file owned by `uid` with a single link, and no larger than MAX_CONFIG_BYTES. Opened with O_NOFOLLOW (and O_NONBLOCK, so a
 * FIFO can't hang the read), then checked and read through the same descriptor, so it can't be
 * swapped between the check and the read.
 * @returns {{ text: string, stat: { uid: number, gid: number, mode: number } } | undefined} undefined when there is no file
 */
export function readOwnedFile(path, uid) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		if (err.code === "ELOOP") throw new UnsafeFile(`${path} is a symlink`);
		throw err;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new UnsafeFile(`${path} is not a regular file`);
		if (st.uid !== uid) throw new UnsafeFile(`${path} is owned by uid ${st.uid}, not the agent user (uid ${uid})`);
		if (st.nlink !== 1) throw new UnsafeFile(`${path} has ${st.nlink} hard links`);
		// Read at most one byte past the limit ourselves: the owner can grow the file after fstat.
		const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
		let length = 0;
		for (let n; length < buf.length && (n = readSync(fd, buf, length, buf.length - length, null)) > 0; ) length += n;
		if (length > MAX_CONFIG_BYTES) throw new UnsafeFile(`${path} is over the ${MAX_CONFIG_BYTES}-byte limit`);
		return { text: buf.toString("utf8", 0, length), stat: { uid: st.uid, gid: st.gid, mode: st.mode } };
	} finally {
		closeSync(fd);
	}
}

/** `io.read`, with an unsafe file turned into `{ unsafe: reason }`. */
function load(io, path, uid) {
	try {
		return io.read(path, uid);
	} catch (err) {
		if (err instanceof UnsafeFile) return { unsafe: err.message };
		throw err;
	}
}

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
 * Set `user`'s entry in the `.claude.json` in `folder`.
 * @param {object} o
 * @param {string} o.folder  the folder holding the file: the agent user's home, or a Claude config folder
 * @param {string} o.user
 * @param {string} o.dir     the agents' socket directory
 * @param {{ uid: number, gid: number }} o.owner  the agent user; owner for a file that has to be created
 * @param {boolean} [o.create=true]  create the file when there is none; when false that is "no-file"
 * @param {object} io        { read(path, uid) -> { text, stat: { uid, gid, mode } } | undefined (see readOwnedFile), write(path, text, { uid, gid, mode }) }
 * @returns {{ status: "created" | "written" | "unchanged" | "unreadable" | "unsafe" | "no-file", key?: string, reason?: string, entry: object, path: string }}
 */
export function applyMcpConfig({ folder, user, dir, owner, create = true }, io) {
	const path = `${folder}/${MCP_FILE}`;
	const entry = mcpEntry(user, dir);
	const before = load(io, path, owner.uid);
	if (before?.unsafe) return { status: "unsafe", reason: before.unsafe, entry, path };
	if (before === undefined && !create) return { status: "no-file", entry, path };
	const merged = mergeEntry(before?.text, user, dir);
	if (merged.status === "unreadable") return { status: "unreadable", entry, path };
	if (merged.status === "unchanged") return { status: "unchanged", key: merged.key, entry, path };
	let target = { ...owner, mode: 0o600 };
	if (before !== undefined) {
		target = { uid: before.stat.uid, gid: before.stat.gid, mode: before.stat.mode & 0o777 };
		io.write(`${folder}/${MCP_BACKUP}`, before.text, target);
	}
	io.write(path, merged.text, target);
	const after = load(io, path, owner.uid);
	if (after?.unsafe || mcpStatus(after?.text, user, dir) !== "ok") throw new Error(`${path}: the broker entry is not there after writing; restore ${MCP_BACKUP} if the file looks wrong`);
	return { status: before === undefined ? "created" : "written", key: merged.key, entry, path };
}

/**
 * Remove the broker entry from the `.claude.json` in `folder`, backing the file up first.
 * @returns {{ status: "removed" | "absent" | "no-file" | "unreadable" | "unsafe", keys?: string[], reason?: string, path: string }}
 */
export function removeMcpConfig({ folder, dir, uid }, io) {
	const path = `${folder}/${MCP_FILE}`;
	const before = load(io, path, uid);
	if (before === undefined) return { status: "no-file", path };
	if (before.unsafe) return { status: "unsafe", reason: before.unsafe, path };
	const dropped = dropEntries(before.text, dir);
	if (dropped.status !== "removed") return { status: dropped.status, path };
	const target = { uid: before.stat.uid, gid: before.stat.gid, mode: before.stat.mode & 0o777 };
	io.write(`${folder}/${MCP_BACKUP}`, before.text, target);
	io.write(path, dropped.text, target);
	return { status: "removed", keys: dropped.keys, path };
}

/** The MCP status of the file in `folder` for `agent list`: mcpStatus, "unsafe (<reason>)", or `ifAbsent` when there is no file and that is given. */
export function mcpFileStatus({ folder, user, dir, uid, ifAbsent }, io) {
	const got = load(io, `${folder}/${MCP_FILE}`, uid);
	if (got === undefined && ifAbsent !== undefined) return ifAbsent;
	return got?.unsafe ? `unsafe (${got.unsafe})` : mcpStatus(got?.text, user, dir);
}

/**
 * The folders in `home` that may be Claude config folders: `.claude*` entries that are real
 * directories (a symlink is skipped; readdir's entry types don't follow it). Whether one holds a
 * `.claude.json` is decided when it's opened, through pinFolder.
 */
export function scanConfigFolders(home, { readdir = readdirSync } = {}) {
	let entries;
	try {
		entries = readdir(home, { withFileTypes: true });
	} catch {
		return []; // no home directory, or root can't list it: only ~/.claude.json is tried
	}
	return entries.filter((e) => e.isDirectory() && e.name.startsWith(".claude")).map((e) => `${home}/${e.name}`).sort();
}

/**
 * The absolute `CLAUDE_CONFIG_DIR` of every `claude` process `uid` is running, read from `proc`.
 * Only root can read another user's environ, which is the case here. The values come from the
 * agent, so pinFolder checks each one before anything is read there.
 */
export function sessionConfigFolders(uid, { proc = "/proc", fs = { readdirSync, statSync, readHead } } = {}) {
	const found = new Set();
	let pids;
	try {
		pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
	} catch {
		return [];
	}
	for (const pid of pids) {
		try {
			if (fs.statSync(`${proc}/${pid}`).uid !== uid) continue;
			const argv = fs.readHead(`${proc}/${pid}/cmdline`, MAX_CMDLINE_BYTES).split("\0");
			if (!isClaude(argv)) continue;
			const env = fs.readHead(`${proc}/${pid}/environ`, MAX_ENVIRON_BYTES).split("\0");
			const value = env.find((e) => e.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length).replace(/\/+$/, "");
			if (value?.startsWith("/")) found.add(value);
		} catch {
			// the process exited while being read
		}
	}
	return [...found].sort();
}

/**
 * Open `folder` as a directory owned by `uid`, without following a symlink, and return an io that
 * reaches the files in it through the open descriptor (`/proc/self/fd/<n>/...`), so the agent
 * can't swap the folder for a symlink between the check and the write. With `within` (the real
 * path of the agent's home), the opened folder must also resolve inside it: owning a folder
 * doesn't mean the agent can reach it (one inside another user's private directory, named through
 * `..` or a symlinked parent), and root shouldn't write where the agent couldn't. Error messages
 * keep the folder's own path. Throws SkippedFolder for a folder root won't use; returns undefined
 * when there is no such folder.
 * @returns {{ io: object, close: () => void } | undefined}
 */
export function pinFolder(folder, uid, io, { within, open = openSync, fstat = fstatSync, close = closeSync, readlink = readlinkSync } = {}) {
	let fd;
	try {
		fd = open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		if (err.code === "ELOOP" || err.code === "ENOTDIR") throw new SkippedFolder(`${folder} is a symlink or not a directory`);
		throw err;
	}
	const base = `/proc/self/fd/${fd}`;
	const refuse = (why) => {
		close(fd);
		throw new SkippedFolder(why);
	};
	const uidOf = fstat(fd).uid;
	if (uidOf !== uid) refuse(`${folder} is owned by uid ${uidOf}, not the agent user (uid ${uid})`);
	if (within !== undefined) {
		const real = readlink(base);
		if (real !== within && !real.startsWith(`${within}/`)) refuse(`${folder} is outside the agent's home directory`);
	}
	const at = (p) => base + p.slice(folder.length);
	const named = (fn) => {
		try {
			return fn();
		} catch (err) {
			if (err instanceof Error) err.message = err.message.split(base).join(folder);
			throw err;
		}
	};
	return {
		io: { read: (p, u) => named(() => io.read(at(p), u)), write: (p, text, owner) => named(() => io.write(at(p), text, owner)) },
		close: () => close(fd)
	};
}
