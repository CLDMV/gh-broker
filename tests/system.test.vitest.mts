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
		download: async () => {
			throw new Error("download must not be needed");
		},
		log: (m: string) => logs.push(m),
		...over
	});
	/**
	 * A world where the given candidate paths exist as root-owned regular files (0755), every
	 * other lstat is a root:root 0755 directory (the ancestors), realpath is the identity, and the
	 * node dir's own stat can be overridden per test.
	 */
	const world = (paths: string[], dirStat: unknown = rootDir()): void => {
		f.existsSync.mockImplementation((p: string) => paths.includes(p));
		f.realpathSync.mockImplementation((p: string) => p);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return dirStat;
			if (paths.includes(p)) return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
	};

	beforeEach(() => (logs.length = 0));

	it("creates a missing directory root:root 0755 and copies the chosen node atomically", async () => {
		world(["/opt/node/bin/node"]);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			if (p === "/opt/node/bin/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/opt/node/bin/node": "v24.11.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v24.11.0" },
				{ pathDirs: () => ["/opt/node/bin"] }
			)
		);
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
		// nothing under /usr/local/bin is ever touched by the broker's node work
		const touched = [...f.rmSync.mock.calls, ...f.renameSync.mock.calls, ...f.copyFileSync.mock.calls]
			.flat()
			.filter((p: unknown) => typeof p === "string");
		expect(touched.filter((p: string) => p.startsWith("/usr/local/bin/"))).toEqual([]);
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
		f.readdirSync.mockReturnValue(["v21.7.3", "v22.12.0", "v24.11.0", "junk"]);
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{
					"/first/node": "v20.15.0", // below the floor: ignored
					"/second/node": "v24.11.0",
					[`${nvm}/v21.7.3/bin/node`]: "v21.7.3", // odd major: ignored
					[`${nvm}/v22.12.0/bin/node`]: "v22.12.0",
					[`${nvm}/v24.11.0/bin/node`]: "v24.11.0",
					"/installer/node": "v23.6.0", // odd major: ignored even though it runs
					[`${NODE_DIR}/node.tmp-${process.pid}`]: "v24.11.0" // the copy is proven to run before the rename
				},
				{ pathDirs: () => ["/first", "/second"], nvmDirs: () => ["/usr/local/nvm"] }
			)
		);
		// the highest qualifying version wins; /second/node and the nvm copy tie at v24.11.0 and the PATH entry wins the tie
		const [src] = f.copyFileSync.mock.calls[0];
		expect(src).toBe("/second/node");
		expect(logs).toEqual(["broker node: v24.11.0 from /second/node"]);
		// a candidate that fails --version is ignored too: /gone/node exists but does not run
		world(["/gone/node", "/second/node"]);
		f.copyFileSync.mockClear();
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/second/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/gone", "/second"] }
			)
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/second/node");
	});

	it("ignores a candidate that exits 0 with garbage instead of a version, and still installs", async () => {
		world(["/garbage/node", "/second/node"]);
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{
					"/garbage/node": "nvm: command not found", // exits 0, prints garbage: skipped, never fatal
					"/second/node": "v22.12.0",
					[`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0"
				},
				{ pathDirs: () => ["/garbage", "/second"] }
			)
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/second/node");
		expect(logs).toEqual(["broker node: v22.12.0 from /second/node"]);
	});

	it("replaces a working copy only with a strictly newer candidate, and never downgrades", async () => {
		world(["/new/node", "/old/node"]);
		// existing v24; only older candidates around: kept, nothing copied
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ [NODE_FILE]: "v24.11.0", "/old/node": "v22.12.0" }, { pathDirs: () => ["/old"] })
		);
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(f.renameSync).not.toHaveBeenCalled();
		expect(logs).toEqual(["broker node: kept v24.11.0 (nothing newer on this box)"]);
		// a newer candidate appears: replaced
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ [NODE_FILE]: "v24.11.0", "/new/node": "v26.1.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v26.1.0" },
				{ pathDirs: () => ["/new"] }
			)
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/new/node");
		expect(f.renameSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, NODE_FILE);
		expect(logs.at(-1)).toBe("broker node: v26.1.0 from /new/node");
	});

	it("keeps an equal-version copy as is, and replaces only a strictly newer one", async () => {
		world(["/same/node"]);
		// the same version is kept as is — the maintainer's rule: update only on strictly newer
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ [NODE_FILE]: "v24.11.0", "/same/node": "v24.11.0" }, { pathDirs: () => ["/same"] })
		);
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(logs).toEqual(["broker node: kept v24.11.0 (nothing newer on this box)"]);
	});

	it("replaces an existing copy that is below the floor like a first install", async () => {
		world(["/old/node", "/new/node"]);
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ [NODE_FILE]: "v20.15.0", "/old/node": "v20.15.0", "/new/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/old", "/new"] }
			)
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/new/node");
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /new/node");
	});

	it("replaces an odd-major copy even when nothing newer exists", async () => {
		world(["/odd/node", "/lts/node"]);
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ [NODE_FILE]: "v23.6.0", "/odd/node": "v23.6.0", "/lts/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/odd", "/lts"] }
			)
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/lts/node"); // the only even, at-or-above-floor candidate
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /lts/node");
	});

	it("replaces a broken copy like a first install, and downloads when nothing qualifies", async () => {
		world(["/broken/node"]);
		// the existing copy does not run: treated like a first install, highest qualifying wins
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ "/broken/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" }, { pathDirs: () => ["/broken"] })
		);
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/broken/node");
		// nothing qualifies anywhere: the download fallback
		f.copyFileSync.mockClear();
		const download = vi.fn(async () => "https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz");
		world([]); // nothing exists: no candidates at all
		await sys.ensureBrokerNodeLink("/installer/node", nodeDeps({ [`${NODE_DIR}/node.tmp-${process.pid}`]: "v24.11.0" }, { download }));
		expect(download).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`);
		expect(f.renameSync).toHaveBeenCalledWith(`${NODE_DIR}/node.tmp-${process.pid}`, NODE_FILE);
		expect(logs.at(-1)).toBe("broker node: v24.11.0 downloaded (https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz)");
	});

	it("removes the temp copy when anything fails, and rethrows", async () => {
		world(["/bad/node"]);
		// the copied binary does not run
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps(
					{ "/bad/node": "v24.11.0" },
					{
						pathDirs: () => ["/bad"],
						// every binary under the broker dir (the temp copy) fails to run; real ones run
						version: async (bin: string) => {
							if (bin.startsWith(NODE_DIR)) throw new Error("ENOEXEC");
							return "v24.11.0";
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
		world([]);
		f.lstatSync.mockImplementation((p: string) =>
			p === NODE_DIR
				? { uid: 1000, gid: 1000, mode: 0o100775, isDirectory: () => true }
				: { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true }
		);
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(
			/\/usr\/local\/lib\/gh-broker is owned by uid 1000\/gid 1000 with mode 775; the broker's node must live in a root:root 0755 directory/
		);
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(/sudo chown root:root/);
		expect(f.copyFileSync).not.toHaveBeenCalled();
		expect(f.renameSync).not.toHaveBeenCalled();
	});

	it("refuses a root:root 0750 directory: the service user could not traverse it", async () => {
		world([]);
		f.lstatSync.mockImplementation((p: string) =>
			p === NODE_DIR
				? { uid: 0, gid: 0, mode: 0o100750, isDirectory: () => true }
				: { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true }
		);
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(
			/\/usr\/local\/lib\/gh-broker is owned by uid 0\/gid 0 with mode 750; the broker's node must live in a root:root 0755 directory/
		);
		expect(f.copyFileSync).not.toHaveBeenCalled();
	});

	it("passes a stat error other than ENOENT through instead of creating the directory", async () => {
		f.realpathSync.mockReturnValue("/opt/node/bin/node");
		f.lstatSync.mockImplementation(() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow("EACCES");
		expect(f.mkdirSync).not.toHaveBeenCalled();
		// and a non-directory at that path (a file, or a symlink — those are always 0777) is refused
		f.lstatSync.mockImplementation((p: string) =>
			p === NODE_DIR
				? { uid: 0, gid: 0, mode: 0o100777, isDirectory: () => false }
				: { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true }
		);
		await expect(sys.ensureBrokerNodeLink("/opt/node/bin/node", nodeDeps({}))).rejects.toThrow(
			/exists but is not a directory \(mode 777\)/
		);
		expect(f.mkdirSync).not.toHaveBeenCalled();
	});

	it("skips a candidate owned by a non-root user, with one logged line", async () => {
		world(["/user/node", "/good/node"]);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return rootDir();
			if (p === "/user/node") return { uid: 1000, gid: 1000, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			if (p === "/user") return { uid: 1000, gid: 1000, mode: 0o040755, isFile: () => false, isDirectory: () => true };
			if (p === "/good/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps({ "/good/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" }, { pathDirs: () => ["/user", "/good"] })
		);
		expect(logs).toContain("broker node: skipping /user/node: owned by uid 1000, not root");
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /good/node"); // the run continues with the safe candidate
	});

	it("skips a group/world-writable candidate", async () => {
		world(["/writable/node", "/good/node"]);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return rootDir();
			if (p === "/writable/node") return { uid: 0, gid: 0, mode: 0o100666, isFile: () => true, isDirectory: () => false };
			if (p === "/good/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/good/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/writable", "/good"] }
			)
		);
		expect(logs).toContain("broker node: skipping /writable/node: is group/world writable");
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /good/node");
	});

	it("skips a candidate under a user-writable ancestor", async () => {
		world(["/opt/node/bin/node", "/good/node"]);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return rootDir();
			if (p === "/opt/node/bin/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			if (p === "/opt/node") return { uid: 0, gid: 1000, mode: 0o040770, isFile: () => false, isDirectory: () => true }; // group-writable dir
			if (p === "/good/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/good/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/opt/node/bin", "/good"] }
			)
		);
		expect(logs).toContain("broker node: skipping /opt/node/bin/node: sits under /opt/node, which is group/world writable");
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /good/node");
	});

	it("skips a symlink resolving into a user's home", async () => {
		world(["/usr/local/bin/node", "/good/node"]);
		f.realpathSync.mockImplementation((p: string) => (p === "/usr/local/bin/node" ? "/home/user/.nvm/versions/node/v24.11.0/bin/node" : p));
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return rootDir();
			if (p === "/home/user/.nvm/versions/node/v24.11.0/bin/node")
				return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			if (p === "/home/user") return { uid: 1000, gid: 1000, mode: 0o040755, isFile: () => false, isDirectory: () => true };
			if (p === "/good/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/good/node": "v22.12.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
				{ pathDirs: () => ["/usr/local/bin", "/good"] }
			)
		);
		expect(logs).toContain("broker node: skipping /usr/local/bin/node: sits under /home/user, owned by uid 1000");
		expect(logs.at(-1)).toBe("broker node: v22.12.0 from /good/node");
	});

	it("refuses when a directory above the node dir is user-owned", async () => {
		world([]);
		f.lstatSync.mockImplementation((p: string) => {
			if (p === "/usr/local/lib") return { uid: 1000, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
			if (p === NODE_DIR) return rootDir();
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		await expect(sys.ensureBrokerNodeLink("/installer/node", nodeDeps({}))).rejects.toThrow(
			/sits under \/usr\/local\/lib, owned by uid 1000 with mode 755; its parents must be root-owned/
		);
		expect(f.mkdirSync).not.toHaveBeenCalled();
	});

	it("refuses a copy that reports an older version than the vetted candidate (a swap)", async () => {
		world(["/new/node"]);
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps(
					// the temp was swapped for an older build between the vet and the copy
					{ "/new/node": "v26.1.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v22.12.0" },
					{ pathDirs: () => ["/new"] }
				)
			)
		).rejects.toThrow(/the copied node reports v22\.12\.0, expected v26\.1\.0; not replacing it/);
		expect(f.renameSync).not.toHaveBeenCalled();
	});

	it("refuses a downloaded copy that is odd or below the floor, and replaces an odd running copy", async () => {
		const temp = `${NODE_DIR}/node.tmp-${process.pid}`;
		world([]); // no candidates anywhere: the download path
		// an odd major
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps({ [temp]: "v23.6.0" }, { download: async () => "https://nodejs.org/dist/v23.6.0/node-v23.6.0-linux-x64.tar.xz" })
			)
		).rejects.toThrow(/the copied node is v23\.6\.0, an odd \(non-LTS\) major; not replacing it/);
		// below the floor
		await expect(
			sys.ensureBrokerNodeLink(
				"/installer/node",
				nodeDeps({ [temp]: "v20.15.0" }, { download: async () => "https://nodejs.org/dist/v20.15.0/node-v20.15.0-linux-x64.tar.xz" })
			)
		).rejects.toThrow(/the copied node is v20\.15\.0, below the 22\.0\.0 floor; not replacing it/);
		expect(f.renameSync).not.toHaveBeenCalled();
		// an operator-placed odd copy is REPLACED by the downloaded LTS: the running copy here is
		// provably unusable, so nothing is "below" anything — the latest LTS wins
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ [NODE_FILE]: "v23.6.0", [temp]: "v24.11.0" },
				{ download: async () => "https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz" }
			)
		);
		expect(f.copyFileSync).not.toHaveBeenCalled(); // the download wrote the temp itself
		expect(f.renameSync).toHaveBeenCalledWith(temp, NODE_FILE);
		expect(logs.at(-1)).toBe("broker node: v24.11.0 downloaded (https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz)");
	});

	it("runs and copies the vetted real path, not an intermediate symlink", async () => {
		// /link/node resolves to the real binary; the version dep only answers for the REAL path,
		// so a run of the symlink path would fail the whole install — and the copy must come from
		// the real path too, so re-pointing the intermediate symlink after the vet changes nothing.
		world(["/link/node"]);
		f.realpathSync.mockImplementation((p: string) => (p === "/link/node" ? "/real/node" : p));
		f.lstatSync.mockImplementation((p: string) => {
			if (p === NODE_DIR) return rootDir();
			if (p === "/link/node" || p === "/real/node") return { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
			return { uid: 0, gid: 0, mode: 0o040755, isFile: () => false, isDirectory: () => true };
		});
		const ran: string[] = [];
		await sys.ensureBrokerNodeLink(
			"/installer/node",
			nodeDeps(
				{ "/real/node": "v24.11.0", [`${NODE_DIR}/node.tmp-${process.pid}`]: "v24.11.0" },
				{
					pathDirs: () => ["/link"],
					version: async (bin: string) => {
						ran.push(bin);
						if (bin === "/real/node") return "v24.11.0";
						if (bin === `${NODE_DIR}/node.tmp-${process.pid}`) return "v24.11.0";
						throw new Error(`${bin} --version failed`);
					}
				}
			)
		);
		expect(ran).toContain("/real/node"); // the vetted real was what ran
		expect(ran).not.toContain("/link/node");
		expect(f.copyFileSync.mock.calls[0]![0]).toBe("/real/node"); // and what was copied
		expect(logs.at(-1)).toBe("broker node: v24.11.0 from /link/node"); // the log keeps the human path
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
