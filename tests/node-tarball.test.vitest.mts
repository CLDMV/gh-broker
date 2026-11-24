import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { distBinMember, distTarballName } from "../src/cli/node-dist.ts";

// Runs the real tar against a tarball shaped like nodejs.org's, so the member path the download
// asks for is checked against an actual archive rather than a mock that repeats the same mistake.
describe("distBinMember against a real nodejs.org-shaped tarball", () => {
	let dir: string;
	beforeEach(() => {
		mkdirSync(join(process.cwd(), "tmp", "agents"), { recursive: true });
		dir = mkdtempSync(join(process.cwd(), "tmp", "agents", "node-tarball-test-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("names the member tar can extract and stream", () => {
		const name = distTarballName("v24.11.0", "x64");
		const top = "node-v24.11.0-linux-x64";
		mkdirSync(join(dir, "src", top, "bin"), { recursive: true });
		writeFileSync(join(dir, "src", top, "bin", "node"), "fake node binary");
		const packed = spawnSync("tar", ["-cJf", "-", "-C", join(dir, "src"), top], { encoding: "buffer", maxBuffer: 1 << 26 });
		expect(packed.status).toBe(0);
		const tarball = packed.stdout as Buffer;

		// the same two calls downloadLatestLts makes, with the verified bytes on stdin
		const member = distBinMember(name);
		mkdirSync(join(dir, "out"));
		const extract = spawnSync("tar", ["-xJf", "-", "--no-same-owner", "-C", join(dir, "out"), member], { input: tarball });
		expect(extract.status, String(extract.stderr)).toBe(0);
		expect(readFileSync(join(dir, "out", member), "utf8")).toBe("fake node binary");
		const streamed = spawnSync("tar", ["-xJOf", "-", member], { input: tarball, encoding: "buffer" });
		expect(streamed.status).toBe(0);
		expect(String(streamed.stdout)).toBe("fake node binary");

		// the old path, the tarball's own file name as the top folder, is not in the archive
		const wrong = spawnSync("tar", ["-xJOf", "-", `${name}/bin/node`], { input: tarball });
		expect(wrong.status).not.toBe(0);
	});
});
