import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, indexTools } from "../src/config.ts";

// loadConfig reads a real file off disk, so we materialize each fixture into the
// repo's gitignored tmp/ and pass the path.
const DIR = join(process.cwd(), "tmp", "config-tests");
let counter = 0;

/** Write `contents` (string or object) to a unique tmp file and return its path. */
function writeConfig(contents: unknown): string {
	const path = join(DIR, `cfg-${counter++}.json`);
	writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
	return path;
}

function baseConfig(): Record<string, unknown> {
	return {
		listen: "unix:/run/gh-broker/gh-broker.sock",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: [{ name: "get_me", mode: "read" }],
		owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } }
	};
}

beforeAll(() => {
	mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

describe("loadConfig — file/parse errors", () => {
	it("throws when the file cannot be read", () => {
		expect(() => loadConfig(join(DIR, "does-not-exist.json"))).toThrow(/cannot read\/parse/);
	});

	it("throws on malformed JSON", () => {
		const p = writeConfig("{ not json ");
		expect(() => loadConfig(p)).toThrow(/cannot read\/parse/);
	});

	it("throws when the root is not an object", () => {
		const p = writeConfig("123");
		expect(() => loadConfig(p)).toThrow(/root must be an object/);
	});

	it("throws when the root is JSON null", () => {
		const p = writeConfig("null");
		expect(() => loadConfig(p)).toThrow(/root must be an object/);
	});
});

describe("loadConfig — listen / upstream", () => {
	it("rejects a non-string listen", () => {
		const c = baseConfig();
		delete c.listen;
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.listen/);
	});

	it("rejects a listen without the unix: prefix", () => {
		const c = baseConfig();
		c.listen = "tcp:0.0.0.0:9000";
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.listen/);
	});

	it("rejects a non-http upstream", () => {
		const c = baseConfig();
		c.upstream = "ftp://example.com";
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.upstream/);
	});

	it("rejects a non-string upstream", () => {
		const c = baseConfig();
		c.upstream = 42;
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.upstream/);
	});
});

describe("loadConfig — tools", () => {
	it("rejects a missing tools array", () => {
		const c = baseConfig();
		delete c.tools;
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.tools: must be a non-empty array/);
	});

	it("rejects an empty tools array", () => {
		const c = baseConfig();
		c.tools = [];
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.tools: must be a non-empty array/);
	});

	it("rejects a tool with no name", () => {
		const c = baseConfig();
		c.tools = [{ mode: "read" }];
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.tools\[0\]\.name: required/);
	});

	it("rejects a tool with a bad mode", () => {
		const c = baseConfig();
		c.tools = [{ name: "get_me", mode: "admin" }];
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.tools\[0\]\.mode: must be read\|write/);
	});

	it("rejects duplicate tool names", () => {
		const c = baseConfig();
		c.tools = [
			{ name: "get_me", mode: "read" },
			{ name: "get_me", mode: "write" }
		];
		expect(() => loadConfig(writeConfig(c))).toThrow(/duplicate tool "get_me"/);
	});

	it("carries the custom flag through, defaulting to false", () => {
		const c = baseConfig();
		c.tools = [
			{ name: "get_me", mode: "read" },
			{ name: "link_issue", mode: "write", custom: true }
		];
		const out = loadConfig(writeConfig(c));
		expect(out.tools).toEqual([
			{ name: "get_me", mode: "read", custom: false },
			{ name: "link_issue", mode: "write", custom: true }
		]);
	});
});

describe("loadConfig — owners", () => {
	it("rejects a non-object owners", () => {
		const c = baseConfig();
		c.owners = "cldmv";
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.owners: must be an object/);
	});

	it("rejects an owner missing read/write", () => {
		const c = baseConfig();
		c.owners = { cldmv: { read: "cred:x" } };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.owners\.cldmv: needs "read" and "write"/);
	});

	it("rejects a non-numeric installationId", () => {
		const c = baseConfig();
		c.owners = { cldmv: { read: "cred:r", write: "cred:w", installationId: "42" } };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.owners\.cldmv\.installationId: must be a number/);
	});

	it("rejects an empty owners object", () => {
		const c = baseConfig();
		c.owners = {};
		expect(() => loadConfig(writeConfig(c))).toThrow(/at least one owner required/);
	});

	it("lowercases owner keys and carries installationId", () => {
		const c = baseConfig();
		c.owners = { CLDMV: { read: "cred:r", write: "cred:w", installationId: 99 } };
		const out = loadConfig(writeConfig(c));
		expect(out.owners).toEqual({ cldmv: { read: "cred:r", write: "cred:w", installationId: 99 } });
	});

	it("omits installationId when absent", () => {
		const out = loadConfig(writeConfig(baseConfig()));
		expect(out.owners.cldmv).toEqual({ read: "cred:cldmv-read", write: "cred:cldmv-write" });
		expect(out.owners.cldmv).not.toHaveProperty("installationId");
	});
});

describe("loadConfig — defaultOwner", () => {
	it("is undefined when omitted", () => {
		const out = loadConfig(writeConfig(baseConfig()));
		expect(out.defaultOwner).toBeUndefined();
	});

	it("lowercases a valid defaultOwner and carries it through", () => {
		const c = baseConfig();
		c.defaultOwner = "CLDMV";
		const out = loadConfig(writeConfig(c));
		expect(out.defaultOwner).toBe("cldmv");
	});

	it("rejects a non-string / empty defaultOwner", () => {
		const c = baseConfig();
		c.defaultOwner = "";
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.defaultOwner: must be a non-empty string/);
	});

	it("rejects a defaultOwner that is not a configured owner", () => {
		const c = baseConfig();
		c.defaultOwner = "nobody";
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.defaultOwner "nobody" is not a key of config\.owners/);
	});
});

describe("loadConfig — app", () => {
	it("rejects a non-numeric appId", () => {
		const c = baseConfig();
		c.app = { appId: "1", privateKey: "cred:app" };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.app\.appId: must be a number/);
	});

	it("rejects a non-string privateKey", () => {
		const c = baseConfig();
		c.app = { appId: 1, privateKey: 5 };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.app\.privateKey/);
	});

	it("carries a valid app config through", () => {
		const c = baseConfig();
		c.app = { appId: 12345, privateKey: "cred:gh-app-key" };
		const out = loadConfig(writeConfig(c));
		expect(out.app).toEqual({ appId: 12345, privateKey: "cred:gh-app-key" });
	});

	it("omits app when absent", () => {
		const out = loadConfig(writeConfig(baseConfig()));
		expect(out.app).toBeUndefined();
	});
});

describe("loadConfig — secrets", () => {
	it("rejects an array (which typeof reports as 'object')", () => {
		const c = baseConfig();
		c.secrets = [];
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets: must be an object/);
	});

	it("rejects null", () => {
		const c = baseConfig();
		c.secrets = null;
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets: must be an object/);
	});

	it("rejects an unknown provider", () => {
		const c = baseConfig();
		c.secrets = { provider: "vault" };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets\.provider/);
	});

	it("carries a valid secrets block through", () => {
		const c = baseConfig();
		c.secrets = { provider: "file", path: "/etc/gh-broker/secrets.json" };
		const out = loadConfig(writeConfig(c));
		expect(out.secrets).toEqual({ provider: "file", path: "/etc/gh-broker/secrets.json" });
	});

	it("rejects a path without the file provider (omitted → systemd-creds default)", () => {
		const c = baseConfig();
		c.secrets = { path: "/etc/gh-broker/secrets.json" };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets\.path is only used by the "file" provider/);
	});

	it("rejects a path with the systemd-creds provider", () => {
		const c = baseConfig();
		c.secrets = { provider: "systemd-creds", path: "/etc/gh-broker/secrets.json" };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets\.path is only used by the "file" provider/);
	});
});

describe("loadConfig — full valid config", () => {
	it("returns the normalized shape", () => {
		const c = baseConfig();
		c.defaultOwner = "cldmv";
		c.app = { appId: 7, privateKey: "cred:app" };
		const out = loadConfig(writeConfig(c));
		expect(out).toEqual({
			listen: "unix:/run/gh-broker/gh-broker.sock",
			upstream: "https://api.githubcopilot.com/mcp/",
			tools: [{ name: "get_me", mode: "read", custom: false }],
			owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
			app: { appId: 7, privateKey: "cred:app" },
			defaultOwner: "cldmv"
		});
	});
});

describe("indexTools", () => {
	it("builds a name→rule map", () => {
		const rules = [
			{ name: "get_me", mode: "read" as const },
			{ name: "create_pull_request", mode: "write" as const, custom: false }
		];
		const map = indexTools(rules);
		expect(map.size).toBe(2);
		expect(map.get("get_me")).toEqual({ name: "get_me", mode: "read" });
		expect(map.get("create_pull_request")).toEqual({ name: "create_pull_request", mode: "write", custom: false });
		expect(map.get("missing")).toBeUndefined();
	});
});
