import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, symlinkSync, linkSync, lstatSync, truncateSync } from "node:fs";
import { join } from "node:path";
import * as m from "../deploy/lib/mcp-config.mjs";
import { writeFileAtomic } from "../deploy/lib/otp.mjs";

const DIR = "/run/gh-broker/agents";
const entry = (u: string) => m.mcpEntry(u, DIR);
const OLD = { type: "stdio", command: "sg", args: ["gh-broker-clients", "-c", "exec socat STDIO UNIX-CONNECT:/run/gh-broker/gh-broker.sock"] };

describe("entry and key", () => {
	it("builds the sg + socat entry", () => {
		expect(entry("repo")).toEqual({ type: "stdio", command: "sg", args: ["gh-broker-agent-repo", "-c", "exec socat STDIO UNIX-CONNECT:/run/gh-broker/agents/repo.sock"] });
	});

	it("finds broker entries by the /run/gh-broker/ path in any field", () => {
		expect(m.brokerKeys({ a: OLD, b: { command: "npx" }, c: null, d: entry("x") })).toEqual(["a", "d"]);
	});

	it("also recognizes entries in a custom agents directory", () => {
		const custom = { command: "sg", args: ["g", "-c", "exec socat STDIO UNIX-CONNECT:/srv/sockets/repo.sock"] };
		expect(m.brokerKeys({ a: custom }, "/srv/sockets")).toEqual(["a"]);
		expect(m.brokerKeys({ a: custom })).toEqual([]);
		expect(m.mcpStatus(JSON.stringify({ mcpServers: { a: custom } }), "repo", "/srv/sockets")).toBe("points elsewhere");
		expect((m.dropEntries(JSON.stringify({ mcpServers: { a: custom } }), "/srv/sockets") as any).keys).toEqual(["a"]);
	});

	it("keeps an existing broker entry's name, else github, gh-broker, gh-broker-<user>", () => {
		expect(m.chooseKey({ other: { command: "x" }, mine: OLD }, "repo")).toBe("mine");
		expect(m.chooseKey({}, "repo")).toBe("github");
		expect(m.chooseKey({ github: { command: "gh" } }, "repo")).toBe("gh-broker");
		expect(m.chooseKey({ github: {}, "gh-broker": {} }, "repo")).toBe("gh-broker-repo");
		expect(m.chooseKey({ github: {}, "gh-broker": {}, "gh-broker-repo": {} }, "repo")).toBe("gh-broker-repo");
	});
});

describe("mcpStatus", () => {
	const file = (servers: unknown) => JSON.stringify({ mcpServers: servers });
	it("reports ok / missing / points elsewhere / unreadable", () => {
		expect(m.mcpStatus(file({ github: entry("repo") }), "repo", DIR)).toBe("ok");
		expect(m.mcpStatus(file({ github: OLD }), "repo", DIR)).toBe("points elsewhere");
		expect(m.mcpStatus(file({ github: entry("other") }), "repo", DIR)).toBe("points elsewhere");
		expect(m.mcpStatus(file({ x: { command: "npx" } }), "repo", DIR)).toBe("missing");
		expect(m.mcpStatus("{}", "repo", DIR)).toBe("missing");
		expect(m.mcpStatus(JSON.stringify({ mcpServers: [] }), "repo", DIR)).toBe("missing");
		expect(m.mcpStatus(undefined, "repo", DIR)).toBe("missing");
		expect(m.mcpStatus("{nope", "repo", DIR)).toBe("unreadable");
		expect(m.mcpStatus("[]", "repo", DIR)).toBe("unreadable");
	});
});

describe("mergeEntry", () => {
	it("creates a config for a missing file", () => {
		const r = m.mergeEntry(undefined, "repo", DIR) as any;
		expect(r.status).toBe("changed");
		expect(JSON.parse(r.text)).toEqual({ mcpServers: { github: entry("repo") } });
		expect(r.text.endsWith("\n")).toBe(true);
	});

	it("touches only the broker key and keeps the rest and the indentation", () => {
		const text = JSON.stringify({ numStartups: 4, projects: { "/x": { a: 1 } }, mcpServers: { github: OLD, other: { command: "npx" } } }, null, "\t") + "\n";
		const r = m.mergeEntry(text, "repo", DIR) as any;
		expect(r.status).toBe("changed");
		expect(r.key).toBe("github");
		const out = JSON.parse(r.text);
		expect(out.numStartups).toBe(4);
		expect(out.projects).toEqual({ "/x": { a: 1 } });
		expect(out.mcpServers.other).toEqual({ command: "npx" });
		expect(out.mcpServers.github).toEqual(entry("repo"));
		expect(r.text.startsWith('{\n\t"numStartups"')).toBe(true);
	});

	it("adds the entry when mcpServers is absent or not an object, defaulting to two spaces", () => {
		expect(JSON.parse((m.mergeEntry('{"a":1}', "repo", DIR) as any).text)).toEqual({ a: 1, mcpServers: { github: entry("repo") } });
		expect((m.mergeEntry('{"a":1}', "repo", DIR) as any).text).toContain('\n  "a": 1');
		expect(JSON.parse((m.mergeEntry('{"mcpServers":[]}', "repo", DIR) as any).text).mcpServers).toEqual({ github: entry("repo") });
	});

	it("reports unchanged and unreadable", () => {
		const text = JSON.stringify({ mcpServers: { gh: entry("repo") } });
		expect(m.mergeEntry(text, "repo", DIR)).toEqual({ status: "unchanged", key: "gh", text });
		expect(m.mergeEntry("{nope", "repo", DIR)).toEqual({ status: "unreadable" });
	});
});

describe("dropEntries", () => {
	it("removes every broker entry and nothing else", () => {
		const text = JSON.stringify({ keep: 1, mcpServers: { a: OLD, b: { command: "npx" }, c: entry("repo") } }, null, 2);
		const r = m.dropEntries(text) as any;
		expect(r.status).toBe("removed");
		expect(r.keys).toEqual(["a", "c"]);
		expect(JSON.parse(r.text)).toEqual({ keep: 1, mcpServers: { b: { command: "npx" } } });
	});

	it("reports absent and unreadable", () => {
		expect(m.dropEntries("{}")).toEqual({ status: "absent" });
		expect(m.dropEntries('{"mcpServers":{"x":{"command":"npx"}}}')).toEqual({ status: "absent" });
		expect(m.dropEntries("{nope")).toEqual({ status: "unreadable" });
	});
});

describe("applyMcpConfig / removeMcpConfig (real files in a scratch dir)", () => {
	let dir: string;
	beforeAll(() => {
		mkdirSync(join(process.cwd(), "tmp", "agents"), { recursive: true });
		dir = mkdtempSync(join(process.cwd(), "tmp", "agents", "mcp-test-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const me = { uid: process.getuid!(), gid: process.getgid!() };
	const fchown = vi.fn();
	const io = {
		read: m.readOwnedFile,
		write: (p: string, text: string, owner: { uid: number; gid: number; mode?: number }) => writeFileAtomic(p, text, owner, { fchown })
	};
	const home = (name: string) => {
		const h = join(dir, name);
		mkdirSync(h, { recursive: true });
		return h;
	};
	const owner = me;

	it("creates a missing file 0600 for the user", () => {
		const h = home("new");
		fchown.mockClear();
		const r = m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, io);
		expect(r).toMatchObject({ status: "created", key: "github", path: `${h}/.claude.json` });
		expect(JSON.parse(readFileSync(`${h}/.claude.json`, "utf8"))).toEqual({ mcpServers: { github: entry("repo") } });
		expect(statSync(`${h}/.claude.json`).mode & 0o777).toBe(0o600);
		expect(fchown).toHaveBeenCalledWith(expect.any(Number), me.uid, me.gid);
		expect(existsSync(`${h}/.claude.json.gh-broker.bak`)).toBe(false);
	});

	it("rewrites an existing file in place, backs it up, keeps its mode, and is idempotent", () => {
		const h = home("old");
		const original = JSON.stringify({ keep: true, mcpServers: { github: OLD } }, null, 2) + "\n";
		writeFileSync(`${h}/.claude.json`, original);
		chmodSync(`${h}/.claude.json`, 0o640);
		const st = statSync(`${h}/.claude.json`);
		fchown.mockClear();
		const r = m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, io);
		expect(r.status).toBe("written");
		expect(readFileSync(`${h}/.claude.json.gh-broker.bak`, "utf8")).toBe(original);
		expect(JSON.parse(readFileSync(`${h}/.claude.json`, "utf8"))).toEqual({ keep: true, mcpServers: { github: entry("repo") } });
		expect(statSync(`${h}/.claude.json`).mode & 0o777).toBe(0o640);
		expect(fchown).toHaveBeenCalledWith(expect.any(Number), st.uid, st.gid);
		const again = m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, io);
		expect(again.status).toBe("unchanged");
	});

	it("leaves an unparseable file alone", () => {
		const h = home("bad");
		writeFileSync(`${h}/.claude.json`, "{nope");
		const r = m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, io);
		expect(r.status).toBe("unreadable");
		expect(r.entry).toEqual(entry("repo"));
		expect(readFileSync(`${h}/.claude.json`, "utf8")).toBe("{nope");
		expect(m.removeMcpConfig({ home: h, uid: me.uid }, io).status).toBe("unreadable");
	});

	it("fails when the entry is not there after writing", () => {
		const h = home("lost");
		const lossy = { ...io, write: (p: string) => { if (p.endsWith(".claude.json")) writeFileSync(p, "{}"); } };
		expect(() => m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, lossy)).toThrow(/not there after writing/);
	});

	it("fails when the file is swapped for a symlink before the read-back", () => {
		const h = home("swapped");
		const target = join(h, "elsewhere.json");
		writeFileSync(target, "{}");
		const swap = { ...io, write: (p: string) => { if (p.endsWith(".claude.json")) symlinkSync(target, p); } };
		expect(() => m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, swap)).toThrow(/not there after writing/);
	});

	it("removes the broker entry with a backup, and reports absent / no file", () => {
		const h = home("rm");
		const original = JSON.stringify({ keep: 1, mcpServers: { github: entry("repo"), other: { command: "npx" } } }, null, 2) + "\n";
		writeFileSync(`${h}/.claude.json`, original);
		const r = m.removeMcpConfig({ home: h, dir: DIR, uid: me.uid }, io);
		expect(r).toMatchObject({ status: "removed", keys: ["github"] });
		expect(readFileSync(`${h}/.claude.json.gh-broker.bak`, "utf8")).toBe(original);
		expect(JSON.parse(readFileSync(`${h}/.claude.json`, "utf8"))).toEqual({ keep: 1, mcpServers: { other: { command: "npx" } } });
		expect(m.removeMcpConfig({ home: h, dir: DIR, uid: me.uid }, io).status).toBe("absent");
		expect(m.removeMcpConfig({ home: home("none"), dir: DIR, uid: me.uid }, io)).toMatchObject({ status: "no-file" });
	});

	it("never follows a symlinked ~/.claude.json: apply, remove and the status leave it and its target alone", () => {
		const h = home("link");
		const secret = join(dir, "secret.json");
		writeFileSync(secret, JSON.stringify({ token: "x", mcpServers: { github: entry("repo") } }));
		symlinkSync(secret, `${h}/.claude.json`);
		const r = m.applyMcpConfig({ home: h, user: "repo", dir: DIR, owner }, io);
		expect(r).toMatchObject({ status: "unsafe", reason: expect.stringContaining("is a symlink") });
		expect(m.removeMcpConfig({ home: h, dir: DIR, uid: me.uid }, io)).toMatchObject({ status: "unsafe" });
		expect(m.mcpFileStatus({ home: h, user: "repo", dir: DIR, uid: me.uid }, io)).toMatch(/^unsafe \(.*is a symlink\)$/);
		expect(lstatSync(`${h}/.claude.json`).isSymbolicLink()).toBe(true);
		expect(existsSync(`${h}/.claude.json.gh-broker.bak`)).toBe(false);
		expect(JSON.parse(readFileSync(secret, "utf8")).token).toBe("x");
	});

	it("mcpFileStatus reports the normal status for a plain file", () => {
		const h = home("plain");
		writeFileSync(`${h}/.claude.json`, JSON.stringify({ mcpServers: { github: entry("repo") } }));
		expect(m.mcpFileStatus({ home: h, user: "repo", dir: DIR, uid: me.uid }, io)).toBe("ok");
		expect(m.mcpFileStatus({ home: home("empty"), user: "repo", dir: DIR, uid: me.uid }, io)).toBe("missing");
	});

	it("passes on an unexpected read error", () => {
		const boom = { ...io, read: () => { throw new Error("EIO"); } };
		expect(() => m.applyMcpConfig({ home: home("eio"), user: "repo", dir: DIR, owner }, boom)).toThrow("EIO");
	});
});

describe("readOwnedFile", () => {
	let dir: string;
	beforeAll(() => {
		mkdirSync(join(process.cwd(), "tmp", "agents"), { recursive: true });
		dir = mkdtempSync(join(process.cwd(), "tmp", "agents", "owned-test-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const uid = process.getuid!();

	it("reads a plain file the user owns, with its owner and mode", () => {
		const p = join(dir, "ok.json");
		writeFileSync(p, "{}");
		const got = m.readOwnedFile(p, uid)!;
		expect(got.text).toBe("{}");
		expect(got.stat).toMatchObject({ uid, gid: statSync(p).gid });
		expect(got.stat.mode & 0o170000).toBe(0o100000);
	});

	it("returns undefined for a missing file and passes on other errors", () => {
		expect(m.readOwnedFile(join(dir, "missing.json"), uid)).toBeUndefined();
		writeFileSync(join(dir, "afile"), "");
		expect(() => m.readOwnedFile(join(dir, "afile", "x"), uid)).toThrow(/ENOTDIR/);
	});

	it("refuses a symlink, a directory, someone else's file and a hard-linked file", () => {
		const p = join(dir, "real.json");
		writeFileSync(p, "{}");
		symlinkSync(p, join(dir, "sym.json"));
		expect(() => m.readOwnedFile(join(dir, "sym.json"), uid)).toThrow(m.UnsafeFile);
		mkdirSync(join(dir, "adir"));
		expect(() => m.readOwnedFile(join(dir, "adir"), uid)).toThrow(/not a regular file/);
		expect(() => m.readOwnedFile(p, uid + 1)).toThrow(/is owned by uid/);
		linkSync(p, join(dir, "hard.json"));
		expect(() => m.readOwnedFile(p, uid)).toThrow(/2 hard links/);
		const big = join(dir, "big.json");
		writeFileSync(big, "");
		truncateSync(big, m.MAX_CONFIG_BYTES + 1);
		expect(() => m.readOwnedFile(big, uid)).toThrow(/over the 16777216-byte limit/);
	});
});
