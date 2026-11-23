import { describe, it, expect } from "vitest";
import { distTarballName, expectedSha, latestLts, sha256Hex, verifyExtracted, verifyTarball } from "../src/cli/node-dist.ts";

const SUMS = `d41d8cd98f00b204e9800998ecf8427e  node-v24.11.0-linux-arm64.tar.xz
5f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80  node-v24.11.0-linux-x64.tar.xz
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.11.0-win-x64.zip
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  node-v24.11.0.tar.xz
`;

describe("latestLts", () => {
	it("takes the first entry with lts set and validates its shape", () => {
		expect(
			latestLts([
				{ version: "v25.0.0", lts: false },
				{ version: "v24.11.0", lts: "jod" },
				{ version: "v22.0.0", lts: true }
			])
		).toBe("v24.11.0");
	});

	it("refuses a non-list, an LTS-less index, and a malformed version", () => {
		expect(() => latestLts({ version: "v24.11.0" })).toThrow(/index.json is not a list/);
		expect(() => latestLts([{ version: "v25.0.0", lts: false }])).toThrow(/no LTS release/);
		expect(() => latestLts([{ version: "24.11.0", lts: true }])).toThrow(/malformed version "24\.11\.0"/);
		expect(() => latestLts([{ version: "v24", lts: true }])).toThrow(/malformed version/);
	});
});

describe("distTarballName", () => {
	it("names the linux tarball for x64 and arm64, and refuses anything else", () => {
		expect(distTarballName("v24.11.0", "x64")).toBe("node-v24.11.0-linux-x64.tar.xz");
		expect(distTarballName("v24.11.0", "arm64")).toBe("node-v24.11.0-linux-arm64.tar.xz");
		expect(() => distTarballName("v24.11.0", "arm")).toThrow(/no build for arm/);
	});
});

describe("expectedSha", () => {
	it("finds the right arch's line in a multi-line SHASUMS body", () => {
		expect(expectedSha(SUMS, "node-v24.11.0-linux-x64.tar.xz")).toBe("5f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80");
		expect(expectedSha(SUMS, "node-v24.11.0-linux-arm64.tar.xz")).toBe("d41d8cd98f00b204e9800998ecf8427e");
	});

	it("fails clearly when the artifact is not listed", () => {
		expect(() => expectedSha(SUMS, "node-v24.11.0-linux-ppc64le.tar.xz")).toThrow(/missing from SHASUMS256\.txt/);
	});
});

describe("verifyTarball / verifyExtracted", () => {
	const bytes = new TextEncoder().encode("tarball bytes");
	const good = sha256Hex(bytes);

	it("accepts the tarball when it hashes to the SHASUMS line", () => {
		expect(() => verifyTarball(bytes, good, "node-v24.11.0-linux-x64.tar.xz")).not.toThrow();
	});

	it("fails a checksum mismatch with both hashes and the unverified-binary verdict", () => {
		expect(() => verifyTarball(bytes, "deadbeef", "node-v24.11.0-linux-x64.tar.xz")).toThrow(
			/checksum mismatch for node-v24\.11\.0-linux-x64\.tar\.xz: expected deadbeef, got 5f1[a-f0-9]+ — not installing an unverified binary/
		);
	});

	it("fails an extracted file that does not match the tarball's own member", () => {
		expect(() => verifyExtracted(good, good, "bin/node")).not.toThrow();
		expect(() => verifyExtracted("swapped", good, "bin/node")).toThrow(
			/the extracted bin\/node does not match the verified tarball \(swapped != 5f1[a-f0-9]+\) — not installing it/
		);
	});
});
