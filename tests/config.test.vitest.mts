import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
		listen: "agents:/run/gh-broker/agents",
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

	it("rejects a listen that isn't agents:<absolute dir>", () => {
		for (const listen of ["tcp:0.0.0.0:9000", "agents:relative/dir", "agents:"]) {
			const c = baseConfig();
			c.listen = listen;
			expect(() => loadConfig(writeConfig(c))).toThrow('config.listen: must be "agents:<absolute directory>", e.g. "agents:/run/gh-broker/agents"');
		}
	});

	it("rejects the old shared unix: socket and says to re-run the installer", () => {
		const c = baseConfig();
		c.listen = "unix:/run/gh-broker/gh-broker.sock";
		expect(() => loadConfig(writeConfig(c))).toThrow(
			'config.listen: the shared "unix:" socket was replaced by one socket per agent; re-run the installer (sudo gh-broker install) to set listen to "agents:/run/gh-broker/agents"'
		);
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
			{ name: "get_me", mode: "read", custom: false, augment: false },
			{ name: "link_issue", mode: "write", custom: true, augment: false }
		]);
	});

	it("carries the augment flag through, defaulting to false", () => {
		const c = baseConfig();
		c.tools = [
			{ name: "get_me", mode: "read" },
			{ name: "pull_request_read", mode: "read", augment: true }
		];
		const out = loadConfig(writeConfig(c));
		expect(out.tools).toEqual([
			{ name: "get_me", mode: "read", custom: false, augment: false },
			{ name: "pull_request_read", mode: "read", custom: false, augment: true }
		]);
	});

	it("refuses a tool on the built-in deny list, even gated, and names why", () => {
		const c = baseConfig();
		c.tools = [{ name: "get_me", mode: "read" }, { name: "push_files", mode: "write", otp: true }];
		expect(() => loadConfig(writeConfig(c))).toThrow('config.tools[1] ("push_files"): never allowed in gh-broker (file writes go through git); remove it from config.tools');
		c.tools = [{ name: "delete_repository", mode: "write" }];
		expect(() => loadConfig(writeConfig(c))).toThrow(/never allowed in gh-broker \(deleting a repo stays a manual step in GitHub\)/);
	});

	it("loads the shipped config.example.json tool list", () => {
		const c = baseConfig();
		c.tools = JSON.parse(readFileSync("config.example.json", "utf8")).tools;
		expect(loadConfig(writeConfig(c)).tools).toHaveLength(84);
	});

	it("rejects a tool marked both custom and augment", () => {
		const c = baseConfig();
		c.tools = [{ name: "weird", mode: "read", custom: true, augment: true }];
		expect(() => loadConfig(writeConfig(c))).toThrow(/custom and augment are mutually exclusive/);
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

	it("carries an empty secrets block, and a provider without a path, through", () => {
		const c = baseConfig();
		c.secrets = {};
		expect(loadConfig(writeConfig(c)).secrets).toEqual({});
		c.secrets = { provider: "file" };
		expect(loadConfig(writeConfig(c)).secrets).toEqual({ provider: "file" });
		c.secrets = { provider: "systemd-creds" };
		expect(loadConfig(writeConfig(c)).secrets).toEqual({ provider: "systemd-creds" });
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

	it("rejects an empty path (would be silently ignored by resolveSecretsPath)", () => {
		const c = baseConfig();
		c.secrets = { provider: "file", path: "" };
		expect(() => loadConfig(writeConfig(c))).toThrow(/config\.secrets\.path: must be a non-empty string/);
	});
});

describe("loadConfig — full valid config", () => {
	it("returns the normalized shape", () => {
		const c = baseConfig();
		c.defaultOwner = "cldmv";
		c.app = { appId: 7, privateKey: "cred:app" };
		const out = loadConfig(writeConfig(c));
		expect(out).toEqual({
			listen: "agents:/run/gh-broker/agents",
			upstream: "https://api.githubcopilot.com/mcp/",
			tools: [{ name: "get_me", mode: "read", custom: false, augment: false }],
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

describe("loadConfig — npm", () => {
	it("is absent unless configured", () => {
		expect(loadConfig(writeConfig(baseConfig())).npm).toBeUndefined();
	});

	it("leaves registry out when it is not set", () => {
		expect(loadConfig(writeConfig({ ...baseConfig(), npm: { token: "cred:npm-token", scopes: ["@cldmv"] } })).npm).toEqual({ token: "cred:npm-token", scopes: ["@cldmv"] });
	});

	it("accepts a token ref, scopes, an https registry and token orgs", () => {
		const npm = { token: "cred:npm-token", scopes: ["@cldmv"], registry: "https://registry.npmjs.org", tokenOrgs: ["cldmv"] };
		expect(loadConfig(writeConfig({ ...baseConfig(), npm })).npm).toEqual(npm);
	});

	it.each([
		[[], /config.npm: must be an object/],
		[{ scopes: ["@cldmv"] }, /config.npm.token/],
		[{ token: "npm_inline_secret", scopes: ["@cldmv"] }, /config.npm.token/],
		[{ token: "cred:npm-token" }, /config.npm.scopes: must be a non-empty array/],
		[{ token: "cred:npm-token", scopes: [] }, /config.npm.scopes: must be a non-empty array/],
		[{ token: "cred:npm-token", scopes: ["cldmv"] }, /config.npm.scopes\[0\]/],
		[{ token: "cred:npm-token", scopes: ["@CLDMV"] }, /config.npm.scopes\[0\]/],
		[{ token: "cred:npm-token", scopes: ["@cldmv"], registry: "http://registry.npmjs.org" }, /config.npm.registry: must be an https URL/],
		[{ token: "cred:npm-token", scopes: ["@cldmv"], tokenOrgs: "cldmv" }, /config.npm.tokenOrgs/],
		[{ token: "cred:npm-token", scopes: ["@cldmv"], tokenOrgs: ["@cldmv"] }, /config.npm.tokenOrgs/]
	] as Array<[unknown, RegExp]>)("rejects an invalid npm block (%#)", (npm, msg) => {
		expect(() => loadConfig(writeConfig({ ...baseConfig(), npm }))).toThrow(msg);
	});
});

describe("loadConfig — ghcr", () => {
	const ghcr = { dropDir: "/srv/gh-broker/ghcr-drop", owners: { cldmv: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot"] } } };

	it("parses a ghcr block", () => {
		const c = loadConfig(writeConfig({ ...baseConfig(), ghcr }));
		expect(c.ghcr?.owners.cldmv?.credential).toBe("cred:cldmv-packages");
		expect(c.ghcr?.protectReleaseTags).toBe(true);
	});

	it("omits ghcr when absent and rejects a malformed block", () => {
		expect(loadConfig(writeConfig(baseConfig())).ghcr).toBeUndefined();
		expect(() => loadConfig(writeConfig({ ...baseConfig(), ghcr: { ...ghcr, dropDir: "/etc/x/y" } }))).toThrow(/config.ghcr.dropDir: may not be under \/etc/);
	});

	it("ships no owner-specific data in config.example.json, and it loads once an owner is added", () => {
		const raw = JSON.parse(readFileSync(join(process.cwd(), "config.example.json"), "utf8"));
		expect(Object.keys(raw).sort()).toEqual(["listen", "otp", "tools", "upstream"]);
		const c = loadConfig(writeConfig({ ...raw, owners: { acme: { read: "cred:acme-read", write: "cred:acme-write" } } }));
		expect(c.tools.filter((t) => t.name.startsWith("ghcr_")).map((t) => [t.name, t.mode, t.custom])).toEqual([
			["ghcr_push", "write", true],
			["ghcr_push_status", "read", true],
			["ghcr_tags", "read", true]
		]);
	});

	it("accepts the documentation-only config.sample.json merged onto the example tools", () => {
		const raw = JSON.parse(readFileSync(join(process.cwd(), "config.example.json"), "utf8"));
		const sample = JSON.parse(readFileSync(join(process.cwd(), "config.sample.json"), "utf8"));
		const c = loadConfig(writeConfig({ ...sample, tools: raw.tools }));
		expect(c.ghcr?.dropDir).toBe("/srv/gh-broker/ghcr-drop");
		expect(c.defaultOwner).toBe("your-org");
	});
});

describe("loadConfig — otp", () => {
	const withTools = (tools: unknown[]) => ({ ...baseConfig(), tools });

	it("parses config.otp, keeping only what was given (defaults live in src/otp/policy.ts)", () => {
		expect(loadConfig(writeConfig({ ...baseConfig(), otp: { seed: "cred:otp-seed" } })).otp).toEqual({ seed: "cred:otp-seed" });
		const full = { seed: "cred:otp-seed", windowSeconds: 120, maxFailures: 3, lockoutSeconds: 60, maxLockouts: 2, statePath: "/var/lib/gh-broker/s.json" };
		expect(loadConfig(writeConfig({ ...baseConfig(), otp: full })).otp).toEqual(full);
		expect(loadConfig(writeConfig(baseConfig())).otp).toBeUndefined();
	});

	it.each([
		[[], /config\.otp: must be an object/],
		[null, /config\.otp: must be an object/],
		[{}, /config\.otp\.seed: must be a "cred:<name>" ref/],
		[{ seed: "GEZDGNBV" }, /config\.otp\.seed: must be a "cred:<name>" ref/],
		[{ seed: "cred:s", windowSeconds: 0 }, /config\.otp\.windowSeconds: must be a positive integer/],
		[{ seed: "cred:s", maxFailures: 1.5 }, /config\.otp\.maxFailures: must be a positive integer/],
		[{ seed: "cred:s", lockoutSeconds: "600" }, /config\.otp\.lockoutSeconds: must be a positive integer/],
		[{ seed: "cred:s", maxLockouts: -1 }, /config\.otp\.maxLockouts: must be a positive integer/],
		[{ seed: "cred:s", statePath: "relative.json" }, /config\.otp\.statePath: must be an absolute path/],
		[{ seed: "cred:s", statePath: 5 }, /config\.otp\.statePath: must be an absolute path/]
	] as Array<[unknown, RegExp]>)("rejects a bad otp block (%#)", (otp, msg) => {
		expect(() => loadConfig(writeConfig({ ...baseConfig(), otp }))).toThrow(msg);
	});

	it("carries a tool's otp flag only when it is set, and rejects a non-boolean", () => {
		const out = loadConfig(writeConfig(withTools([{ name: "get_me", mode: "read" }, { name: "a", mode: "write", otp: true }, { name: "b", mode: "write", otp: false }])));
		expect(out.tools).toEqual([
			{ name: "get_me", mode: "read", custom: false, augment: false },
			{ name: "a", mode: "write", custom: false, augment: false, otp: true },
			{ name: "b", mode: "write", custom: false, augment: false, otp: false }
		]);
		expect(() => loadConfig(writeConfig(withTools([{ name: "a", mode: "write", otp: "yes" }])))).toThrow(/config\.tools\[0\]\.otp: must be true or false/);
	});

	it("otp_status must be custom and can't be gated", () => {
		expect(loadConfig(writeConfig(withTools([{ name: "otp_status", mode: "read", custom: true, otp: false }]))).tools[0]).toMatchObject({ name: "otp_status", otp: false });
		expect(() => loadConfig(writeConfig(withTools([{ name: "otp_status", mode: "read", custom: true, otp: true }])))).toThrow(/"otp_status"\): can't be gated/);
		expect(() => loadConfig(writeConfig(withTools([{ name: "otp_status", mode: "read" }])))).toThrow(/"otp_status"\): must be custom: true/);
	});

	it("config.example.json enables otp_status and the otp block", () => {
		const raw = JSON.parse(readFileSync(join(process.cwd(), "config.example.json"), "utf8"));
		const c = loadConfig(writeConfig({ ...raw, owners: { acme: { read: "cred:acme-read", write: "cred:acme-write" } } }));
		expect(c.otp).toEqual({ seed: "cred:otp-seed" });
		expect(c.tools.find((t) => t.name === "otp_status")).toEqual({ name: "otp_status", mode: "read", custom: true, augment: false });
		expect(c.tools.filter((t) => t.otp !== undefined)).toEqual([]);
	});
});
