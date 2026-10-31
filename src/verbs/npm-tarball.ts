/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/npm-tarball.ts
 *	@Date: 2026-10-31T10:56:28-07:00 (1793469388)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T11:04:31-07:00 (1793469871)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * A minimal npm package tarball: gzip over a POSIX ustar archive whose entries sit under
 * `package/`, the layout `npm pack` produces. It exists so npm_scaffold can publish a
 * placeholder built entirely by the broker (no agent-supplied files) without pulling in a
 * tar dependency. Only regular files, only short ASCII paths: exactly what a placeholder needs.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/** npm pack's fixed mtime (1985-10-26T08:15:00Z), so the tarball is reproducible. */
const MTIME = 499162500;
const BLOCK = 512;

export interface TarFile {
	/** Path inside `package/`, e.g. "package.json". */
	path: string;
	content: string;
}

function header(name: string, size: number): Buffer {
	const h = Buffer.alloc(BLOCK, 0);
	const put = (value: string, offset: number, length: number): void => {
		h.write(value, offset, length, "ascii");
	};
	const octal = (n: number, length: number): string => n.toString(8).padStart(length - 1, "0") + "\0";
	put(name, 0, 100);
	put(octal(0o644, 8), 100, 8);
	put(octal(0, 8), 108, 8);
	put(octal(0, 8), 116, 8);
	put(octal(size, 12), 124, 12);
	put(octal(MTIME, 12), 136, 12);
	put("        ", 148, 8); // checksum field counts as spaces while summing
	put("0", 156, 1); // regular file
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	let sum = 0;
	for (const byte of h) sum += byte;
	put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
	return h;
}

export function buildTarball(files: TarFile[]): Buffer {
	const parts: Buffer[] = [];
	for (const f of files) {
		const name = `package/${f.path}`;
		if (!/^[\x20-\x7e]+$/.test(name) || name.length > 100) throw new Error(`npm-tarball: unsupported path "${f.path}"`);
		const body = Buffer.from(f.content, "utf8");
		parts.push(header(name, body.length), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK, 0));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0));
	return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** The `dist` integrity fields the registry expects for a tarball. */
export function tarballDigests(tarball: Buffer): { integrity: string; shasum: string } {
	return {
		integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
		shasum: createHash("sha1").update(tarball).digest("hex")
	};
}
