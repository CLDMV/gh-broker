import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

// Every host-touching primitive is mocked: nothing here spawns a process or touches the real filesystem.
const h = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: h.spawnSync }));
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	chmodSync: vi.fn(),
	chownSync: vi.fn(),
	lstatSync: vi.fn(),
	writeFileSync: vi.fn(),
	cpSync: vi.fn(),
	rmSync: vi.fn(),
	renameSync: vi.fn(),
	realpathSync: vi.fn(),
	copyFileSync: vi.fn(),
	readdirSync: vi.fn()
}));

import * as fs from "node:fs";
import * as sys from "../src/cli/system.ts";

const f = vi.mocked(fs) as any;
const ok = (stdout = "", stderr = "") => ({ status: 0, stdout, stderr });
const fail = (status = 1, stdout = "", stderr = "") => ({ status, stdout, stderr });

/** Route spawnSync by `cmd args...` string prefix; unmatched commands succeed with empty output. */
function route(map: Record<string, any>) {
	h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
		const line = [cmd, ...args].join(" ");
		for (const [k, v] of Object.entries(map)) if (line.startsWith(k)) return typeof v === "function" ? v(line) : v;
		return ok();
	});
}
const calls = () => h.spawnSync.mock.calls.map((c: any[]) => [c[0], ...c[1]].join(" "));

beforeEach(() => {
	h.spawnSync.mockReset();
	for (const k of Object.keys(f)) if (typeof f[k]?.mockReset === "function") f[k].mockReset();
});

describe("run / has / isRoot", () => {
	it("returns the result on success and passes options through", () => {
		h.spawnSync.mockReturnValue(ok("x"));
		expect(sys.run("echo", ["a"], { input: "i" }).stdout).toBe("x");
		expect(h.spawnSync).toHaveBeenCalledWith("echo", ["a"], { encoding: "utf8", input: "i" });
		sys.run("echo"); // default args
	});

	it("throws when the process could not be spawned", () => {
		h.spawnSync.mockReturnValue({ error: new Error("ENOENT") });
		expect(() => sys.run("nope")).toThrow("nope: ENOENT");
	});

	it("throws on a non-zero exit with stderr, then stdout, then nothing", () => {
		h.spawnSync.mockReturnValue(fail(2, "out", "err"));
		expect(() => sys.run("c", ["a", "b"])).toThrow("c a b exited 2: err");
		h.spawnSync.mockReturnValue(fail(2, "out", ""));
		expect(() => sys.run("c")).toThrow("exited 2: out");
		h.spawnSync.mockReturnValue(fail(2, "", ""));
		expect(() => sys.run("c")).toThrow(/exited 2: $/);
	});

	it("allowFail returns the failing result instead of throwing", () => {
		h.spawnSync.mockReturnValue(fail(3));
		expect(sys.run("c", [], { allowFail: true }).status).toBe(3);
	});

	it("has() reflects `command -v`", () => {
		h.spawnSync.mockReturnValue({ status: 0 });
		expect(sys.has("rsync")).toBe(true);
		h.spawnSync.mockReturnValue({ status: 1 });
		expect(sys.has("rsync")).toBe(false);
	});

	it("isRoot() follows getuid", () => {
		const orig = process.getuid;
		try {
			process.getuid = () => 0;
			expect(sys.isRoot()).toBe(true);
			process.getuid = () => 1000;
			expect(sys.isRoot()).toBe(false);
			(process as any).getuid = undefined;
			expect(sys.isRoot()).toBe(false);
		} finally {
			process.getuid = orig;
		}
	});
});

describe("user / group lookups", () => {
	it("userExists / groupExists use the exit status", () => {
		route({ id: ok(), getent: fail(2) });
		expect(sys.userExists("u")).toBe(true);
		expect(sys.groupExists("g")).toBe(false);
	});

	it("gidOf parses getent output, and is undefined on failure or junk", () => {
		route({ getent: ok("grp:x:994:\n") });
		expect(sys.gidOf("grp")).toBe(994);
		route({ getent: fail(2) });
		expect(sys.gidOf("grp")).toBeUndefined();
		route({ getent: ok("grp:x:abc:\n") });
		expect(sys.gidOf("grp")).toBeUndefined();
	});

	it("uidOf parses `id -u`, and is undefined on failure or junk", () => {
		route({ id: ok("1001\n") });
		expect(sys.uidOf("u")).toBe(1001);
		route({ id: fail(1) });
		expect(sys.uidOf("u")).toBeUndefined();
		route({ id: ok("junk\n") });
		expect(sys.uidOf("u")).toBeUndefined();
	});

	it("requireGid / requireUid throw a clear error when unresolved", () => {
		route({ getent: ok("g:x:5:\n"), id: ok("7\n") });
		expect(sys.requireGid("g")).toBe(5);
		expect(sys.requireUid("u")).toBe(7);
		route({ getent: fail(2), id: fail(1) });
		expect(() => sys.requireGid("g")).toThrow('cannot resolve gid for group "g"');
		expect(() => sys.requireUid("u")).toThrow('cannot resolve uid for user "u"');
	});
});

describe("account creation", () => {
	it("ensureGroup only creates a missing group", () => {
		route({ getent: ok() });
		sys.ensureGroup("g");
		expect(calls()).not.toContain("groupadd --system g");
		h.spawnSync.mockReset();
		route({ getent: fail(2) });
		sys.ensureGroup("g");
		expect(calls()).toContain("groupadd --system g");
	});

	it("ensureServiceUser creates a missing user", () => {
		route({ getent: ok(), id: fail(1) });
		sys.ensureServiceUser("svc", "svcg");
		const useradd = calls().find((c) => c.startsWith("useradd"))!;
		expect(useradd).toContain("--system --gid svcg --home-dir");
		expect(useradd).not.toContain("--groups");
		expect(useradd.endsWith(" svc")).toBe(true);
	});

	it("ensureServiceUser leaves an existing user alone", () => {
		route({ getent: ok(), id: ok() });
		sys.ensureServiceUser("svc", "svcg");
		expect(calls().some((c) => c.startsWith("useradd"))).toBe(false);
		expect(calls().some((c) => c.startsWith("usermod"))).toBe(false);
	});

	it("ensureAgentGroup creates the agent's group with exactly the service user and the agent", () => {
		route({ getent: fail(2) });
		sys.ensureAgentGroup("repo");
		expect(calls()).toEqual([
			"getent group gh-broker-agent-repo",
			"groupadd --system gh-broker-agent-repo",
			"gpasswd --members gh-broker,repo gh-broker-agent-repo"
		]);
		h.spawnSync.mockReset();
		route({ getent: ok("x:x:1:") });
		sys.ensureAgentGroup("repo", "svc");
		expect(calls()).not.toContain("groupadd --system gh-broker-agent-repo");
		expect(calls()).toContain("gpasswd --members svc,repo gh-broker-agent-repo");
	});

	it("removeAgentGroup empties the group (keeping its gid) only when it exists", () => {
		route({ getent: ok("x:x:1:") });
		sys.removeAgentGroup("repo");
		expect(calls()).toContain("gpasswd --members  gh-broker-agent-repo");
		expect(calls().some((c) => c.startsWith("groupdel"))).toBe(false);
		h.spawnSync.mockReset();
		route({ getent: fail(2) });
		sys.removeAgentGroup("repo");
		expect(calls().some((c) => c.startsWith("gpasswd"))).toBe(false);
	});

	it("createAgentUser creates a plain user", () => {
		route({});
		sys.createAgentUser("agent");
		expect(calls()).toContain("useradd --create-home --shell /bin/bash agent");
	});
});

describe("systemd-creds", () => {
	it("trySystemdCredDecrypt returns null when the file or the tool is missing", () => {
		f.existsSync.mockReturnValue(false);
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBeNull();
		f.existsSync.mockReturnValue(true);
		route({ sh: fail(1) });
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBeNull();
	});

	it("trySystemdCredDecrypt returns the token without its trailing newline", () => {
		f.existsSync.mockReturnValue(true);
		route({ sh: ok(), "systemd-creds": ok("tok\r\n") });
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBe("tok");
		expect(calls()).toContain("systemd-creds decrypt --name=n /c -");
	});

	it("trySystemdCredDecrypt returns null for a failed decrypt, empty output or a spawn error", () => {
		f.existsSync.mockReturnValue(true);
		route({ sh: ok(), "systemd-creds": fail(1) });
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBeNull();
		route({ sh: ok(), "systemd-creds": ok("\n") });
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBeNull();
		route({ sh: ok(), "systemd-creds": () => ({ error: new Error("spawn failed") }) });
		expect(sys.trySystemdCredDecrypt("n", "/c")).toBeNull();
	});

	it("systemdCredsEncrypt feeds the plaintext on stdin and locks the file down", () => {
		route({});
		sys.systemdCredsEncrypt("n", "secret", "/etc/x/n.cred");
		expect(h.spawnSync).toHaveBeenCalledWith(
			"systemd-creds",
			["encrypt", "--name=n", "-", "/etc/x/n.cred"],
			expect.objectContaining({ input: "secret" })
		);
		expect(f.chmodSync).toHaveBeenCalledWith("/etc/x/n.cred", 0o400);
		expect(f.chownSync).toHaveBeenCalledWith("/etc/x/n.cred", 0, 0);
	});

	it("ensureCredsDir creates <configDir>/creds as 0750 root:group", () => {
		route({ getent: ok("g:x:42:\n") });
		f.existsSync.mockReturnValue(false);
		sys.ensureCredsDir("/etc/gh-broker", "g");
		expect(f.mkdirSync).toHaveBeenCalledWith("/etc/gh-broker/creds", { recursive: true, mode: 0o750 });
		expect(f.chmodSync).toHaveBeenCalledWith("/etc/gh-broker/creds", 0o750);
		expect(f.chownSync).toHaveBeenCalledWith("/etc/gh-broker/creds", 0, 42);
	});

	it("ensureCredsDir leaves an existing directory in place but re-applies mode and owner", () => {
		route({ getent: ok("g:x:42:\n") });
		f.existsSync.mockReturnValue(true);
		sys.ensureCredsDir("/etc/gh-broker", "g");
		expect(f.mkdirSync).not.toHaveBeenCalled();
		expect(f.chownSync).toHaveBeenCalled();
	});

	it("writeCredsDropin writes one LoadCredentialEncrypted line per name and reloads", () => {
		route({});
		f.existsSync.mockReturnValue(true);
		sys.writeCredsDropin(["a", "b"], "/etc/gh-broker/creds");
		const [path, body, opts] = f.writeFileSync.mock.calls[0];
		expect(path).toBe("/etc/systemd/system/gh-broker.service.d/creds.conf");
		expect(body).toBe(
			"[Service]\nLoadCredentialEncrypted=a:/etc/gh-broker/creds/a.cred\nLoadCredentialEncrypted=b:/etc/gh-broker/creds/b.cred\n"
		);
		expect(opts).toEqual({ mode: 0o644 });
		expect(calls()).toContain("systemctl daemon-reload");
		sys.writeCredsDropin([], "/c", "other.service");
		expect(f.writeFileSync.mock.calls[1][0]).toBe("/etc/systemd/system/other.service.d/creds.conf");
	});

	it("removeCredsDropin removes the drop-in and reloads only when it exists", () => {
		route({});
		f.existsSync.mockReturnValue(false);
		sys.removeCredsDropin();
		expect(f.rmSync).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
		f.existsSync.mockReturnValue(true);
		sys.removeCredsDropin("x.service");
		expect(f.rmSync).toHaveBeenCalledWith("/etc/systemd/system/x.service.d/creds.conf", { force: true });
		expect(calls()).toContain("systemctl daemon-reload");
	});
});

describe("broker node copy", () => {
	const NODE_DIR = "/usr/local/lib/gh-broker";
	const NODE_FILE = "/usr/local/lib/gh-broker/node";
	const rootDir = () => ({ uid: 0, gid: 0, mode: 0o100755, isDirectory: () => true });
	const logs: string[] = [];
	/** The injected NodeSourceDeps: `versions` maps a binary path to the version it prints when run. */
	const nodeDeps = (versions: Record<string, string>, over: Partial<sys.NodeSourceDeps> = {}): sys.NodeSourceDeps => ({
		floor: "22.0.0",
		pathDirs: () => [],
		nvmDirs: () => [],
		listVersions: () => [],
		version: async (bin: string) => {
			const v = versions[bin];
			if (v === undefined) throw new Error(`${bin} --version failed`);
			return v;
		},
		sha256: async (path: string) => `sha(${path})`,
		download: async () => {
			throw new Error("download must not be needed");
		},
		log: (m: string) => logs.push(m),
		...over
	});
	/** A world where the given paths exist (candidate discovery) and realpath(nodeBin) is the running node. */
	const world = (paths: string[]): void => {
		f.existsSync.mockImplementation((p: string) => paths.includes(p));
		f.realpathSync.mockReturnValue("/installer/node");
	};

	beforeEach(() => (logs.length = 0));

	it("creates a missing directory root:root 0755 and copies the chosen node atomically", async () => {
		world(["/opt/node/bin/node"]);
		f.lstatSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({ "/installer/node": "v22.12.0", "/opt/node/bin/node": "v24.11.0" }));
		expect(f.mkdirSync).toHaveBeenCalledWith(NODE_DIR, { recursive: true, mode: 0o755 });
		expect(f.chmodSync).toHaveBeenCalledWith(NODE_DIR, 0o755);
		expect(f.chownSync).toHaveBeenCalledWith(NODE_DIR, 0, 0);
		// the copy lands in a temp file in the SAME directory, is proven to run, then renamed over
		const [src, tempPath] = f.copyFileSync.mock.calls[0];
		expect(src).toBe("/opt/node/bin/node"); // the highest qualifying candidate
		expect(tempPath).toBe(`${NODE_DIR}/node.tmp-${process.pid}`);
		expect(f.chmodSync).toHaveBeenCalledWith(tempPath, 0o755);
		expect(f.renameSync).toHaveBeenCalledWith(tempPath, NODE_FILE);
		expect(f.rmSync).not.toHaveBeenCalled(); // success leaves no temp behind
		expect(logs).toEqual(["broker node: v24.11.0 from /opt/node/bin/node"]);
	});

	it("discovers candidates in order and vets them: PATH entries first, odd majors and below-floor and failing ones ignored", async () => {
		const nvm = "/usr/local/nvm/versions/node";
		world([
			"/first/node",
			"/second/node",
			`${nvm}/v21.7.3/bin/node`,
			`${nvm}/v22.12.0/bin/node`,
			`${nvm}/v24.11.0/bin/node`,
			"/installer/node"
		]);
		f.lstatSync.mockReturnValue(rootDir());
		f.readdirSync.mockReturnValue(["v21.7.3", "v22.12.0", "v24.11.0", "junk"]);
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({
				"/first/node": "v20.15.0", // below the floor: ignored
				"/second/node": "v24.11.0",
				[`${nvm}/v21.7.3/bin/node`]: "v21.7.3", // odd major: ignored
				[`${nvm}/v22.12.0/bin/node`]: "v22.12.0",
				[`${nvm}/v24.11.0/bin/node`]: "v24.11.0",
				"/installer/node": "v23.6.0" // odd major: ignored even though it runs
			})
		);
		// the highest qualifying version wins; a tie (none here) would keep the PATH one first
		const [src] = f.copyFileSync.mock.calls[0];
		expect(src).toBe("/second/node");
		expect(logs).toEqual(["broker node: v24.11.0 from /second/node"]);
		// a candidate that fails --version is ignored too: /gone/node exists but does not run
		world(["/gone/node", "/second/node"]);
		f.copyFileSync.mockClear();
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ "/second/node": "v22.12.0", "/gone/node": undefined as unknown as string })
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/second/node");
	});

	it("replaces a working copy only with a strictly newer candidate, and never downgrades", async () => {
		world(["/new/node", "/old/node"]);
		f.lstatSync.mockReturnValue(rootDir());
		// existing v24; only older candidates around: kept, nothing copied
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({ NODE_FILE: "v24.11.0", "/old/node": "v22.12.0" }));
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(f.renameSync).not.toHaveBeenCalled();
		expect(logs).toEqual(["broker node: kept v24.11.0 (nothing newer on this box)"]);
		// a newer candidate appears: replaced
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({ NODE_FILE: "v24.11.0", "/new/node": "v26.1.0" }));
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/new/node");
		expect(f.renameSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, NODE_FILE);
		expect(logs.at(-1)).toBe("broker node: v26.1.0 from /new/node");
	});

	it("skips the copy when the existing file's version and sha256 both match, replaces on a sha difference", async () => {
		world(["/same/node"]);
		f.lstatSync.mockReturnValue(rootDir());
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ NODE_FILE: "v24.11.0", "/same/node": "v24.11.0" }, { sha256: async (p) => `sha(${p})` })
		);
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(logs).toEqual([`broker node: kept v24.11.0 (same version and sha256 as /same/node)`]);
		// same version, different build: replaced
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ NODE_FILE: "v24.11.0", "/same/node": "v24.11.0" }, { sha256: async () => "different" })
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/same/node");
		expect(logs.at(-1)).toBe("broker node: v24.11.0 from /same/node");
	});

	it("replaces a broken copy like a first install, and downloads when nothing qualifies", async () => {
		world(["/broken/node"]);
		f.lstatSync.mockReturnValue(rootDir());
		// the existing copy does not run: treated like a first install, highest qualifying wins
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({ "/broken/node": "v22.12.0" }));
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/broken/node");
		// nothing qualifies anywhere: the download fallback
		f.copyFileSync.mockClear();
		const download = vi.fn(async () => ({
			version: "24.11.0",
			source: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz"
		}));
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({}, { download }));
		expect(download).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`);
		expect(f.renameSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, NODE_FILE);
		expect(logs.at(-1)).toBe("broker node: v24.11.0 downloaded (nodejs.org dist, latest LTS)");
	});

	it("removes the temp copy when anything fails, and rethrows", async () => {
		world(["/bad/node"]);
		f.lstatSync.mockReturnValue(rootDir());
		// the copied binary does not run
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps(
					{ "/bad/node": "v24.11.0" },
					{
						version: async () => {
							throw new Error("ENOEXEC");
						}
					}
				)
			)
		).rejects.toThrow("ENOEXEC");
		expect(f.rmSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, { force: true });
		expect(f.renameSync).not.toHaveBeenCalled();
		// the download fails: same cleanup
		f.rmSync.mockClear();
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps(
					{},
					{
						download: async () => {
							throw new Error("checksum mismatch");
						}
					}
				)
			)
		).rejects.toThrow("checksum mismatch");
		expect(f.rmSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, { force: true });
	});

	it("refuses an existing directory root did not create, naming the owner, the mode and the fix", async () => {
		f.realpathSync.mockReturnValue("/opt/node/bin/node");
		f.lstatSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o100775, isDirectory: () => true });
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(
			/\/usr\/local\/lib\/gh-broker is owned by uid 1000\/gid 1000 with mode 775; the broker's node must live in a root:root 0755 directory/
		);
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(/sudo chown root:root/);
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(f.renameSync).not.toHaveBeenCalled();
	});

	it("nodeFloorMin takes the minimum semver literal out of an engines range", () => {
		expect(sys.nodeFloorMin(">=22.0.0")).toBe("22.0.0");
		expect(sys.nodeFloorMin("^22.0.0")).toBe("22.0.0");
		expect(sys.nodeFloorMin(">=20.0.0 <23")).toBe("20.0.0");
		expect(() => sys.nodeFloorMin("latest")).toThrow(/cannot parse a node version/);
	});

	it("currentNodeBin resolves the running node's real path", () => {
		f.realpathSync.mockReturnValue("/real/node");
		expect(sys.currentNodeBin()).toBe("/real/node");
		expect(f.realpathSync).toHaveBeenCalledWith(process.execPath);
	});

	it("the shipped unit runs the broker's own node", async () => {
		// node:fs is mocked in this file; the shipped unit is a real file, so read it for real
		const realFs = (await vi.importActual("node:fs")) as typeof import("node:fs");
		const unit = realFs.readFileSync(join(import.meta.dirname, "..", "deploy", "gh-broker.service"), "utf8");
		expect(unit).toContain("ExecStart=/usr/local/lib/gh-broker/node /opt/gh-broker/dist/index.mjs");
		expect(unit).not.toContain("/usr/local/bin/node");
	});
});

describe("ensureDropDir", () => {
	const st = (kind: "dir" | "link" | "file") => ({
		uid: 2002,
		isSymbolicLink: () => kind === "link",
		isDirectory: () => kind === "dir"
	});
	beforeEach(() => route({ getent: ok("g:x:42:\n"), id: ok("1001\n") }));

	it("creates a missing parent (0755) and a missing dir (0750), then sets owner and 2750", () => {
		f.existsSync.mockReturnValue(false);
		f.lstatSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(sys.ensureDropDir("/var/lib/drop/in", "agent", "g")).toEqual({ created: true });
		expect(f.mkdirSync).toHaveBeenCalledWith("/var/lib/drop", { recursive: true, mode: 0o755 });
		expect(f.mkdirSync).toHaveBeenCalledWith("/var/lib/drop/in", { mode: 0o750 });
		expect(f.chownSync).toHaveBeenCalledWith("/var/lib/drop/in", 1001, 42);
		expect(f.chmodSync).toHaveBeenCalledWith("/var/lib/drop/in", 0o2750);
	});

	it("reuses an existing parent and directory, keeping the directory's owner", () => {
		f.existsSync.mockReturnValue(true);
		f.lstatSync.mockReturnValue(st("dir"));
		expect(sys.ensureDropDir("/var/lib/drop/in", "agent", "g")).toEqual({ created: false });
		expect(f.mkdirSync).not.toHaveBeenCalled();
		expect(f.chownSync).toHaveBeenCalledWith("/var/lib/drop/in", 2002, 42);
		expect(f.chmodSync).toHaveBeenCalledWith("/var/lib/drop/in", 0o2750);
	});

	it("refuses a symlink and a non-directory", () => {
		f.existsSync.mockReturnValue(true);
		f.lstatSync.mockReturnValue(st("link"));
		expect(() => sys.ensureDropDir("/d/x", "agent", "g")).toThrow("is a symlink");
		f.lstatSync.mockReturnValue(st("file"));
		expect(() => sys.ensureDropDir("/d/x", "agent", "g")).toThrow("is not a directory");
		expect(f.chownSync).not.toHaveBeenCalled();
	});
});

describe("directories, unit and service", () => {
	beforeEach(() => route({ getent: ok("g:x:42:\n"), id: ok("1001\n") }));

	it("ensureDirs creates config (0750 root:group) and app (0755 svc:group) dirs", () => {
		f.existsSync.mockReturnValue(false);
		sys.ensureDirs("/etc/gh-broker", "/opt/gh-broker", "svc", "g");
		expect(f.chownSync).toHaveBeenCalledWith("/etc/gh-broker", 0, 42);
		expect(f.chownSync).toHaveBeenCalledWith("/opt/gh-broker", 1001, 42);
		expect(f.chmodSync).toHaveBeenCalledWith("/opt/gh-broker", 0o755);
	});

	it("installUnit copies, chmods and reloads (default and explicit destination)", () => {
		sys.installUnit("/src/u.service");
		expect(f.cpSync).toHaveBeenCalledWith("/src/u.service", "/etc/systemd/system/gh-broker.service");
		sys.installUnit("/src/u.service", "/x/y.service");
		expect(f.chmodSync).toHaveBeenCalledWith("/x/y.service", 0o644);
		expect(calls().filter((c) => c === "systemctl daemon-reload")).toHaveLength(2);
	});

	it("enable / restart / serviceActive drive systemctl", () => {
		route({ "systemctl enable": fail(1), "systemctl is-active": ok("active\n") });
		sys.enableService(); // allowFail: a failing enable does not throw
		sys.restartService();
		expect(sys.serviceActive()).toBe("active");
		expect(calls()).toContain("systemctl restart gh-broker.service");
		route({ "systemctl restart": fail(1, "", "boom") });
		expect(() => sys.restartService()).toThrow("boom");
	});

	it("deployDist rsyncs when rsync exists", () => {
		route({ getent: ok("g:x:42:\n"), id: ok("1001\n"), sh: ok() });
		f.existsSync.mockReturnValue(true);
		sys.deployDist("/src/dist", "/opt/gh-broker", "svc", "g");
		// The library bundle (dist/core/) is excluded: its imports are external and cannot
		// resolve from the no-node_modules /opt tree — the deployed daemon is dist/index.mjs.
		expect(calls()).toContain("rsync -a --delete --exclude core/ /src/dist/ /opt/gh-broker/dist/");
		expect(calls()).toContain("chown -R 1001:42 /opt/gh-broker");
		expect(f.cpSync).not.toHaveBeenCalled();
	});

	it("deployDist falls back to rm + cp without rsync", () => {
		route({ getent: ok("g:x:42:\n"), id: ok("1001\n"), sh: fail(1) });
		f.existsSync.mockReturnValue(true);
		sys.deployDist("/src/dist", "/opt/gh-broker", "svc", "g");
		expect(f.rmSync).toHaveBeenCalledWith("/opt/gh-broker/dist", { recursive: true, force: true });
		expect(f.cpSync).toHaveBeenCalledWith("/src/dist", "/opt/gh-broker/dist", { recursive: true });
		expect(calls().some((c) => c.startsWith("rsync"))).toBe(false);
	});

	it("writeConfigFile writes tab-indented JSON as 0640 root:group", () => {
		sys.writeConfigFile("/etc/gh-broker/config.json", { a: 1 }, "g");
		expect(f.writeFileSync).toHaveBeenCalledWith("/etc/gh-broker/config.json", '{\n\t"a": 1\n}\n', { mode: 0o640 });
		expect(f.chmodSync).toHaveBeenCalledWith("/etc/gh-broker/config.json", 0o640);
		expect(f.chownSync).toHaveBeenCalledWith("/etc/gh-broker/config.json", 0, 42);
	});
});

afterEach(() => vi.clearAllMocks());
