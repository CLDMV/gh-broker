import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
	symlinkSync: vi.fn(),
	realpathSync: vi.fn()
}));

import * as fs from "node:fs";
import * as sys from "../deploy/lib/system.mjs";

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

	it("addUserToGroup appends the group", () => {
		route({});
		sys.addUserToGroup("u", "g");
		expect(calls()).toContain("usermod --append --groups g u");
	});

	it("ensureServiceUser creates a missing user", () => {
		route({ getent: ok(), id: fail(1) });
		sys.ensureServiceUser("svc", "svcg", "clients");
		const useradd = calls().find((c) => c.startsWith("useradd"))!;
		expect(useradd).toContain("--system --gid svcg --groups clients");
		expect(useradd.endsWith(" svc")).toBe(true);
	});

	it("ensureServiceUser only adds an existing user to the clients group", () => {
		route({ getent: ok(), id: ok() });
		sys.ensureServiceUser("svc", "svcg", "clients");
		expect(calls().some((c) => c.startsWith("useradd"))).toBe(false);
		expect(calls()).toContain("usermod --append --groups clients svc");
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

describe("node symlinks", () => {
	it("links only the binaries that exist next to the given node", () => {
		f.existsSync.mockImplementation((p: string) => p !== "/opt/node/bin/npx");
		expect(sys.pointNodeSymlinks("/opt/node/bin/node")).toEqual(["node", "npm"]);
		expect(f.rmSync).toHaveBeenCalledWith("/usr/local/bin/node", { force: true });
		expect(f.symlinkSync).toHaveBeenCalledWith("/opt/node/bin/node", "/usr/local/bin/node");
		expect(f.symlinkSync).not.toHaveBeenCalledWith("/opt/node/bin/npx", "/usr/local/bin/npx");
	});

	it("currentNodeBin resolves the running node's real path", () => {
		f.realpathSync.mockReturnValue("/real/node");
		expect(sys.currentNodeBin()).toBe("/real/node");
		expect(f.realpathSync).toHaveBeenCalledWith(process.execPath);
	});
});

describe("ensureDropDir", () => {
	const st = (kind: "dir" | "link" | "file") => ({
		isSymbolicLink: () => kind === "link",
		isDirectory: () => kind === "dir"
	});
	beforeEach(() => route({ getent: ok("g:x:42:\n"), id: ok("1001\n") }));

	it("creates a missing parent (0755) and a missing dir (0750), then sets owner and 2750", () => {
		f.existsSync.mockReturnValue(false);
		f.lstatSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		sys.ensureDropDir("/var/lib/drop/in", "agent", "g");
		expect(f.mkdirSync).toHaveBeenCalledWith("/var/lib/drop", { recursive: true, mode: 0o755 });
		expect(f.mkdirSync).toHaveBeenCalledWith("/var/lib/drop/in", { mode: 0o750 });
		expect(f.chownSync).toHaveBeenCalledWith("/var/lib/drop/in", 1001, 42);
		expect(f.chmodSync).toHaveBeenCalledWith("/var/lib/drop/in", 0o2750);
	});

	it("reuses an existing parent and directory", () => {
		f.existsSync.mockReturnValue(true);
		f.lstatSync.mockReturnValue(st("dir"));
		sys.ensureDropDir("/var/lib/drop/in", "agent", "g");
		expect(f.mkdirSync).not.toHaveBeenCalled();
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
		expect(calls()).toContain("rsync -a --delete /src/dist/ /opt/gh-broker/dist/");
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
