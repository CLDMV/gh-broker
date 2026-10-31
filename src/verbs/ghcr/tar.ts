/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/tar.ts
 *	@Date: 2026-10-31T10:58:00-07:00 (1793469480)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T11:13:30-07:00 (1793470410)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Minimal read-only tar index for `docker save` / OCI-layout archives.
 *
 * Only headers are read: the index records where each member's data lives in the file
 * (offset + size) so blobs can be streamed straight from the already-open descriptor
 * with positional reads. Nothing is extracted to disk, and links inside the archive are
 * resolved against the archive's own member names, never the filesystem.
 *
 * Supported: ustar/POSIX headers, PAX extended headers (`path`, `linkpath`, `size`), GNU
 * long names (`L`/`K`), base-256 sizes, regular files, hard links and symlinks. Global PAX
 * headers, directories and every other type are skipped.
 */

import { readSync } from "node:fs";
import { posix } from "node:path";

export interface TarMember {
	/** Byte offset of the member's data in the archive. */
	offset: number;
	size: number;
}

export interface TarIndex {
	/** Regular members by normalized name (links already resolved). */
	files: Map<string, TarMember>;
}

const BLOCK = 512;
/** Bounds the header scan so a hostile archive can't make the index unbounded. */
export const MAX_TAR_MEMBERS = 100_000;
const MAX_EXT_HEADER = 1024 * 1024;
const MAX_LINK_DEPTH = 16;

export class TarError extends Error {}

const fail = (msg: string): never => {
	throw new TarError(`archive: ${msg}`);
};

function readAt(fd: number, position: number, length: number): Buffer {
	const buf = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buf, got, length - got, position + got);
		if (n === 0) break;
		got += n;
	}
	if (got !== length) fail(`truncated at byte ${position + got}`);
	return buf;
}

function cstr(buf: Buffer, start: number, len: number): string {
	const slice = buf.subarray(start, start + len);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? len : nul).toString("utf8");
}

function parseSize(buf: Buffer): number {
	const field = buf.subarray(124, 136);
	if (field[0]! & 0x80) {
		// base-256 (GNU) for members over 8 GiB
		let n = 0;
		for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
		if (!Number.isSafeInteger(n)) fail("member size out of range");
		return n;
	}
	const s = cstr(field, 0, 12).trim();
	if (!/^[0-7]*$/.test(s)) fail("bad size field in tar header");
	return s ? parseInt(s, 8) : 0;
}

function checksumOk(buf: Buffer): boolean {
	const stored = cstr(buf, 148, 8).trim();
	if (!/^[0-7]+$/.test(stored)) return false;
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i]!;
	return sum === parseInt(stored, 8);
}

function parsePax(data: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let i = 0;
	while (i < data.length) {
		const sp = data.indexOf(0x20, i);
		if (sp === -1) break;
		const len = parseInt(data.subarray(i, sp).toString("ascii"), 10);
		if (!Number.isInteger(len) || len <= 0 || i + len > data.length) fail("bad PAX header record");
		const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
		const eq = rec.indexOf("=");
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		i += len;
	}
	return out;
}

/** Normalize a member name: strip leading "./" and "/", collapse "..". Returns "" for the root. */
export function normName(name: string): string {
	const n = posix.normalize(`/${name}`).slice(1);
	return n.replace(/\/+$/, "");
}

/** Index every member of the tar archive open at `fd` (`size` bytes long). */
export function indexTar(fd: number, size: number): TarIndex {
	const files = new Map<string, TarMember>();
	const links = new Map<string, { target: string; hard: boolean }>();
	let pos = 0;
	let members = 0;
	let pax: Record<string, string> = {};
	let longName: string | undefined;
	let longLink: string | undefined;

	while (pos + BLOCK <= size) {
		const hdr = readAt(fd, pos, BLOCK);
		if (hdr.every((b) => b === 0)) break; // end-of-archive marker
		if (!checksumOk(hdr)) fail(`bad tar header checksum at byte ${pos}`);
		if (++members > MAX_TAR_MEMBERS) fail(`more than ${MAX_TAR_MEMBERS} members`);

		const type = String.fromCharCode(hdr[156]!);
		let memberSize = parseSize(hdr);
		const dataAt = pos + BLOCK;
		const next = dataAt + Math.ceil(memberSize / BLOCK) * BLOCK;

		if (type === "x" || type === "g" || type === "L" || type === "K") {
			if (memberSize > MAX_EXT_HEADER) fail("extended header too large");
			const data = readAt(fd, dataAt, memberSize);
			if (type === "x") pax = parsePax(data);
			else if (type === "L") longName = cstr(data, 0, data.length);
			else if (type === "K") longLink = cstr(data, 0, data.length);
			// "g" (global PAX) carries nothing this reader needs.
			pos = next;
			continue;
		}

		const prefix = cstr(hdr, 345, 155);
		const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${cstr(hdr, 0, 100)}` : cstr(hdr, 0, 100));
		const linkName = pax.linkpath ?? longLink ?? cstr(hdr, 157, 100);
		if (pax.size !== undefined) {
			if (!/^\d+$/.test(pax.size)) fail("bad PAX size");
			memberSize = Number(pax.size);
		}
		const dataEnd = dataAt + Math.ceil(memberSize / BLOCK) * BLOCK;
		pax = {};
		longName = undefined;
		longLink = undefined;

		const name = normName(rawName);
		if (type === "0" || type === "\0" || type === "7") {
			if (dataAt + memberSize > size) fail(`member "${name}" runs past the end of the file`);
			files.set(name, { offset: dataAt, size: memberSize });
			links.delete(name);
		} else if (type === "1") {
			links.set(name, { target: normName(linkName), hard: true });
			files.delete(name);
		} else if (type === "2") {
			links.set(name, { target: normName(posix.join(posix.dirname(name), linkName)), hard: false });
			files.delete(name);
		}
		pos = dataEnd;
	}

	// Resolve links to the regular member they finally point at, within the archive only.
	for (const [name, link] of links) {
		let target = link.target;
		for (let depth = 0; ; depth++) {
			if (depth > MAX_LINK_DEPTH) fail(`link loop at "${name}"`);
			const hit = files.get(target);
			if (hit) {
				files.set(name, hit);
				break;
			}
			const hop = links.get(target);
			if (!hop) break; // dangling link: simply not a readable member
			target = hop.target;
		}
	}
	return { files };
}

/** Read one (small) member fully, refusing anything larger than `max`. */
export function readMember(fd: number, m: TarMember, max: number, what: string): Buffer {
	if (m.size > max) fail(`${what} is ${m.size} bytes — larger than the ${max}-byte limit`);
	return readAt(fd, m.offset, m.size);
}

/** Read the first `n` bytes of a member (for magic-number sniffing). */
export function peekMember(fd: number, m: TarMember, n: number): Buffer {
	return readAt(fd, m.offset, Math.min(n, m.size));
}
