import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real effects behind the CLI, with their process and filesystem access mocked: nothing here
// spawns npm or touches the filesystem.
const h = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: h.spawnSync }));
vi.mock("node:fs", () => {
	const fns = [
		"writeFileSync",
		"chmodSync",
		"chownSync",
		"readFileSync",
		"existsSync",
		"statSync",
		"rmSync",
		"openSync",
		"writeSync",
		"fsyncSync",
		"closeSync",
		"renameSync",
		"fchmodSync",
		"fchownSync",
		"mkdirSync",
		"mkdtempSync",
		"cpSync",
		"symlinkSync",
		"realpathSync",
		"lstatSync",
		"readdirSync",
		"readlinkSync",
		"fstatSync",
		"readSync"
	];
	const mock: Record<string, unknown> = {
		constants: {
			O_RDONLY: 0,
			O_WRONLY: 1,
			O_CREAT: 64,
			O_EXCL: 128,
			O_TRUNC: 512,
			O_NONBLOCK: 2048,
			O_DIRECTORY: 65536,
			O_NOFOLLOW: 131072
		}
	};
	for (const fn of fns) mock[fn] = vi.fn();
	return mock;
});

import * as fs from "node:fs";
import { downloadLatestLts, realDeps } from "../src/cli/real-deps.ts";
import { sha256Hex } from "../src/cli/node-dist.ts";

const f = vi.mocked(fs) as any;
const ok = (stdout = ""): { status: number; stdout: string; stderr: string } => ({ status: 0, stdout, stderr: "" });

beforeEach(() => {
	h.spawnSync.mockReset();
	for (const k of Object.keys(f)) if (typeof f[k]?.mockReset === "function") f[k].mockReset();
});

describe("installedVersion / deployedVersion", () => {
	it("reads the global npm package's version, and undefined when there is none", () => {
		f.readFileSync.mockReturnValue(JSON.stringify({ version: "0.13.0" }));
		expect(realDeps().installedVersion()).toBe("0.13.0");
		f.readFileSync.mockImplementation(() => {
			throw Object.assign(new Error("nope"), { code: "ENOENT" });
		});
		expect(realDeps().installedVersion()).toBeUndefined();
		f.readFileSync.mockReturnValue(JSON.stringify({ version: 3 }));
		expect(realDeps().installedVersion()).toBeUndefined();
	});

	it("reads the deployed /opt copy's version through the pinned read, and undefined when absent", () => {
		f.openSync.mockReturnValue(7);
		f.fstatSync.mockReturnValue({ isFile: () => true, uid: 0, gid: 0, mode: 0o100644, nlink: 1 });
		let reads = 0;
		f.readSync.mockImplementation((_fd: number, buf: Buffer, off: number, len: number) => {
			if (reads++) return 0;
			const s = Buffer.from("0.12.0\n");
			s.copy(buf, off, 0, Math.min(s.length, len));
			return Math.min(s.length, len);
		});
		expect(realDeps().deployedVersion()).toBe("0.12.0");
		f.openSync.mockImplementation(() => {
			throw Object.assign(new Error("nope"), { code: "ENOENT" });
		});
		expect(realDeps().deployedVersion()).toBeUndefined();
	});
});

describe("latestVersion", () => {
	it("asks npm for the package's version from / with the registry pinned", () => {
		h.spawnSync.mockReturnValue(ok("0.13.0\n"));
		expect(realDeps().latestVersion()).toBe("0.13.0");
		const [cmd, args, opts] = h.spawnSync.mock.calls[0]!;
		expect(cmd).toBe("npm");
		expect(args).toEqual(["view", "@cldmv/gh-broker", "version", "--registry", "https://registry.npmjs.org"]);
		expect(opts.cwd).toBe("/");
	});

	it("is undefined when npm fails or answers with something that isn't a semver version", () => {
		h.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "network down" });
		expect(realDeps().latestVersion()).toBeUndefined();
		h.spawnSync.mockReturnValue(ok("npm ERR! nonsense"));
		expect(realDeps().latestVersion()).toBeUndefined();
		// the same bar --version is held to: a dist-tag or any other spec is not a version
		for (const answer of ["next", "latest", "0.13", "https://registry.example/x"]) {
			h.spawnSync.mockReturnValue(ok(answer + "\n"));
			expect(realDeps().latestVersion()).toBeUndefined();
		}
		h.spawnSync.mockReturnValue(ok("0.13.0-rc.1\n"));
		expect(realDeps().latestVersion()).toBe("0.13.0-rc.1");
	});
});

describe("npmInstall", () => {
	it("streams the install from / with the registry pinned", () => {
		h.spawnSync.mockReturnValue(ok());
		realDeps().npmInstall("0.13.0");
		const [cmd, args, opts] = h.spawnSync.mock.calls[0]!;
		expect(cmd).toBe("npm");
		expect(args).toEqual([
			"install",
			"-g",
			"--prefix",
			"/usr/local",
			"--ignore-scripts",
			"--registry",
			"https://registry.npmjs.org",
			"@cldmv/gh-broker@0.13.0"
		]);
		expect(opts).toEqual({ stdio: "inherit", cwd: "/" });
	});

	it("fails loudly on a non-zero exit, a signal kill, and a spawn error", () => {
		h.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
		expect(() => realDeps().npmInstall("0.13.0")).toThrow("npm install exited 1");
		h.spawnSync.mockReturnValue({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
		expect(() => realDeps().npmInstall("0.13.0")).toThrow("npm install exited on signal SIGKILL");
		h.spawnSync.mockReturnValue({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" });
		expect(() => realDeps().npmInstall("0.13.0")).toThrow("npm install: ENOENT");
	});
});

describe("now / sleep (reconnect --wait)", () => {
	it("sleep blocks for about the time asked, and now is the wall clock", () => {
		const start = realDeps().now();
		expect(Math.abs(start - Date.now())).toBeLessThan(1000);
		realDeps().sleep(30);
		expect(realDeps().now() - start).toBeGreaterThanOrEqual(25);
	});
});

describe("runNewBinary", () => {
	it("runs the newly installed binary as a child with inherited stdio", () => {
		h.spawnSync.mockReturnValue(ok());
		realDeps().runNewBinary(["install", "--claude-config", "repo:/srv/x"]);
		const [cmd, args, opts] = h.spawnSync.mock.calls[0]!;
		expect(cmd).toBe(process.execPath); // the maintained node, not whatever the PATH shebang finds
		expect(args).toEqual(["/usr/local/bin/gh-broker", "install", "--claude-config", "repo:/srv/x"]);
		expect(opts).toEqual({ stdio: "inherit" });
	});

	it("reports a non-zero exit, a signal kill, and a spawn error with the args that ran", () => {
		h.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["agent", "reconnect"])).toThrow("/usr/local/bin/gh-broker agent reconnect exited 1");
		let caught: unknown;
		try {
			realDeps().runNewBinary(["agent", "reconnect"]);
		} catch (err) {
			caught = err;
		}
		expect(caught).toMatchObject({ status: 1 }); // upgrade tells a reconnect that only skipped panes (3) from a failure by this
		h.spawnSync.mockReturnValue({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["install"])).toThrow("/usr/local/bin/gh-broker install exited on signal SIGTERM");
		h.spawnSync.mockReturnValue({ error: new Error("EACCES"), status: null, stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["install"])).toThrow("/usr/local/bin/gh-broker install: EACCES");
	});
});

describe("downloadLatestLts", () => {
	const INDEX = JSON.stringify([
		{ version: "v25.0.0", lts: false },
		{ version: "v24.11.0", lts: "jod" }
	]);
	const member = Buffer.from("the real node binary");
	const tarball = Buffer.from("the verified tarball bytes");
	const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "x64";
	const name = `node-v24.11.0-linux-${arch}.tar.xz`;
	const tarballUrl = `https://nodejs.org/dist/v24.11.0/${name}`;
	const fetched: string[] = [];

	const stubFetch = (tarballBody: Buffer = tarball, sums = `${sha256Hex(tarball)}  ${name}\n`): void => {
		fetched.length = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const u = String(url);
				fetched.push(u);
				if (u.endsWith("/index.json"))
					return { ok: true, status: 200, text: async () => INDEX, arrayBuffer: async () => new ArrayBuffer(0) };
				if (u.endsWith("SHASUMS256.txt"))
					return { ok: true, status: 200, text: async () => sums, arrayBuffer: async () => new ArrayBuffer(0) };
				return {
					ok: true,
					status: 200,
					text: async () => "",
					arrayBuffer: async () => tarballBody.buffer.slice(tarballBody.byteOffset, tarballBody.byteOffset + tarballBody.byteLength)
				};
			})
		);
	};

	beforeEach(() => {
		f.readFileSync.mockImplementation((p: string) => (String(p).includes("bin/node") ? member : "{}"));
		f.mkdtempSync.mockReturnValue("/tmp/gh-broker-node-abc123");
		h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
			const line = [cmd, ...args].join(" ");
			if (line.startsWith("tar -xJOf")) return { status: 0, stdout: member, stderr: "" };
			return { status: 0, stdout: "", stderr: "" };
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("downloads once, verifies, extracts into a fresh mkdtemp dir with the archive's ownership discarded, and re-hashes the extracted binary", async () => {
		stubFetch();
		await expect(downloadLatestLts("/usr/local/lib/gh-broker/node.tmp-1")).resolves.toBe(tarballUrl);
		// S1: exactly one fetch of the tarball — the verified bytes are the bytes written
		expect(fetched.filter((u) => u === tarballUrl)).toHaveLength(1);
		expect(fetched.filter((u) => u.includes("node-v24.11.0-linux"))).toHaveLength(1);
		// B1: a fresh 0700-root mkdtemp dir (never a predictable pid-named one), tar drops the
		// archive's own ownership, and the extracted file is re-hashed against the member streamed
		// from the same verified tarball
		expect(f.mkdtempSync).toHaveBeenCalledWith(expect.stringMatching(/gh-broker-node-$/));
		const tarArgs = h.spawnSync.mock.calls.find((c: any[]) => c[0] === "tar" && c[1]![0] === "-xJf")![1] as string[];
		expect(tarArgs).toContain("--no-same-owner");
		expect(f.writeFileSync).toHaveBeenCalledWith(`/tmp/gh-broker-node-abc123/${name}`, tarball);
		expect(f.copyFileSync).toHaveBeenCalledWith(`/tmp/gh-broker-node-abc123/${name}/bin/node`, "/usr/local/lib/gh-broker/node.tmp-1");
	});

	it("fails a checksum mismatch without extracting anything", async () => {
		stubFetch(tarball, `deadbeef  ${name}\n`);
		await expect(downloadLatestLts("/d/node")).rejects.toThrow(/checksum mismatch.*not installing an unverified binary/);
		expect(f.writeFileSync).not.toHaveBeenCalled();
		expect(f.copyFileSync).not.toHaveBeenCalled();
	});

	it("fails offline with a clear message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			})
		);
		await expect(downloadLatestLts("/d/node")).rejects.toThrow(/cannot reach https:\/\/nodejs\.org\/dist\/index\.json/);
	});

	it("fails when the extracted file does not match the tarball's own member (a swap)", async () => {
		stubFetch();
		f.readFileSync.mockImplementation((p: string) => (String(p).includes("bin/node") ? Buffer.from("swapped binary") : "{}"));
		await expect(downloadLatestLts("/d/node")).rejects.toThrow(/does not match the verified tarball/);
		expect(f.copyFileSync).not.toHaveBeenCalled();
	});

	it("removes the work dir (tarball included) even when the extraction fails", async () => {
		stubFetch();
		h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
			const line = [cmd, ...args].join(" ");
			if (line.startsWith("tar -xJf")) return { status: 2, stdout: "", stderr: "tar: error" };
			if (line.startsWith("tar -xJOf")) return { status: 0, stdout: member, stderr: "" };
			return { status: 0, stdout: "", stderr: "" };
		});
		await expect(downloadLatestLts("/d/node")).rejects.toThrow(/tar/);
		expect(f.rmSync).toHaveBeenCalledWith("/tmp/gh-broker-node-abc123", { recursive: true, force: true });
	});
});
