import { describe, it, expect, vi, beforeEach } from "vitest";

// The real effects behind the CLI, with their process and filesystem access mocked: nothing here
// spawns npm or touches the filesystem.
const h = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: h.spawnSync }));
vi.mock("node:fs", () => {
	const fns = ["writeFileSync", "chmodSync", "chownSync", "readFileSync", "existsSync", "statSync", "rmSync", "openSync", "writeSync", "fsyncSync", "closeSync", "renameSync", "fchmodSync", "fchownSync", "mkdirSync", "cpSync", "symlinkSync", "realpathSync", "lstatSync", "readdirSync", "readlinkSync", "fstatSync", "readSync"];
	const mock: Record<string, unknown> = { constants: { O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_NONBLOCK: 2048, O_DIRECTORY: 65536, O_NOFOLLOW: 131072 } };
	for (const fn of fns) mock[fn] = vi.fn();
	return mock;
});

import * as fs from "node:fs";
import { realDeps } from "../src/cli/real-deps.ts";

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
		f.readFileSync.mockImplementation(() => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
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
		f.openSync.mockImplementation(() => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
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

	it("is undefined when npm fails or answers with something that isn't a version", () => {
		h.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "network down" });
		expect(realDeps().latestVersion()).toBeUndefined();
		h.spawnSync.mockReturnValue(ok("npm ERR! nonsense"));
		expect(realDeps().latestVersion()).toBeUndefined();
	});
});

describe("npmInstall", () => {
	it("streams the install from / with the registry pinned", () => {
		h.spawnSync.mockReturnValue(ok());
		realDeps().npmInstall("0.13.0");
		const [cmd, args, opts] = h.spawnSync.mock.calls[0]!;
		expect(cmd).toBe("npm");
		expect(args).toEqual(["install", "-g", "--prefix", "/usr/local", "--ignore-scripts", "--registry", "https://registry.npmjs.org", "@cldmv/gh-broker@0.13.0"]);
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

describe("runNewBinary", () => {
	it("runs the newly installed binary as a child with inherited stdio", () => {
		h.spawnSync.mockReturnValue(ok());
		realDeps().runNewBinary(["install", "--claude-config", "repo:/srv/x"]);
		const [cmd, args, opts] = h.spawnSync.mock.calls[0]!;
		expect(cmd).toBe("/usr/local/bin/gh-broker");
		expect(args).toEqual(["install", "--claude-config", "repo:/srv/x"]);
		expect(opts).toEqual({ stdio: "inherit" });
	});

	it("reports a non-zero exit, a signal kill, and a spawn error with the args that ran", () => {
		h.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["agent", "reconnect"])).toThrow("/usr/local/bin/gh-broker agent reconnect exited 1");
		h.spawnSync.mockReturnValue({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["install"])).toThrow("/usr/local/bin/gh-broker install exited on signal SIGTERM");
		h.spawnSync.mockReturnValue({ error: new Error("EACCES"), status: null, stdout: "", stderr: "" });
		expect(() => realDeps().runNewBinary(["install"])).toThrow("/usr/local/bin/gh-broker install: EACCES");
	});
});
