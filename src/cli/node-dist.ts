/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/node-dist.ts
 *	@Date: 2026-11-22T23:26:52-08:00 (1795418812)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T23:28:43-08:00 (1795418923)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Pure checks for the nodejs.org dist download behind ensureBrokerNodeLink (the wiring — fetch,
 * tar, filesystem — stays in real-deps.ts). Everything here is measured: picking and validating
 * the LTS release, parsing SHASUMS256.txt, and the hash comparisons that keep an unverified
 * binary off the box.
 */
import { createHash } from "node:crypto";

/** The version of the first LTS entry in nodejs.org/dist/index.json, shape-checked. */
export function latestLts(index: unknown): string {
	if (!Array.isArray(index)) throw new Error("node download: nodejs.org/dist/index.json is not a list");
	const entry = index.find((e) => Boolean((e as { lts?: unknown }).lts));
	if (!entry) throw new Error("node download: no LTS release in nodejs.org/dist/index.json");
	const version = (entry as { version?: unknown }).version;
	if (typeof version !== "string" || !/^v\d+\.\d+\.\d+$/.test(version))
		throw new Error(`node download: dist entry has a malformed version ${JSON.stringify(version)}`);
	return version;
}

/** The dist tarball name for a version and arch; only x64 and arm64 are published for Linux. */
export function distTarballName(version: string, arch: string): string {
	if (arch !== "x64" && arch !== "arm64") throw new Error(`node download: nodejs.org has no build for ${arch}`);
	return `node-${version}-linux-${arch}.tar.xz`;
}

/**
 * The node binary's path inside a nodejs.org tarball: the archive's top folder is the tarball's
 * name without `.tar.xz` (`node-v24.11.0-linux-x64/bin/node`), never the file name itself.
 */
export function distBinMember(tarballName: string): string {
	if (!tarballName.endsWith(".tar.xz")) throw new Error(`node download: ${tarballName} is not a .tar.xz tarball`);
	return `${tarballName.slice(0, -".tar.xz".length)}/bin/node`;
}

/** The expected sha256 of `name` out of a SHASUMS256.txt body; a missing line is a hard failure. */
export function expectedSha(sums: string, name: string): string {
	const line = sums
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.endsWith(` ${name}`));
	if (!line) throw new Error(`node download: ${name} is missing from SHASUMS256.txt`);
	return line.split(/\s+/)[0]!;
}

export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The tarball must hash to exactly what SHASUMS256.txt says; anything else is a hard failure. */
export function verifyTarball(data: Uint8Array, expected: string, name: string): void {
	const actual = sha256Hex(data);
	if (actual !== expected)
		throw new Error(
			`node download: checksum mismatch for ${name}: expected ${expected}, got ${actual} — not installing an unverified binary`
		);
}

/**
 * A file extracted from the verified tarball must hash the same as the member streamed straight
 * out of that tarball: a swap between extraction and copy is a hard failure.
 */
export function verifyExtracted(actual: string, reference: string, what: string): void {
	if (actual !== reference)
		throw new Error(
			`node download: the extracted ${what} does not match the verified tarball (${actual} != ${reference}) — not installing it`
		);
}
