import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseConfigLib } from "../src/config.ts";

// Pins for the config two-part split (design #175 slice 0): parseConfigLib validates the
// library half of a config (tools, owners, defaultOwner, app, npm, ghcr) and loadConfig
// composes it with the daemon-only fields (listen, upstream, secrets, otp). These tests
// pin that the split is exact: same accepted values, same error texts, same validation
// order, and the daemon-only fields left entirely to loadConfig.

const DIR = join(process.cwd(), "tmp", "config-lib-tests");
let counter = 0;

/** Write `contents` to a unique tmp file and return its path. */
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

/** The lib fields of a loaded config, in parseConfigLib's terms. */
function libOf(config: ReturnType<typeof loadConfig>) {
	const { listen: _listen, upstream: _upstream, secrets: _secrets, otp: _otp, ...lib } = config;
	return lib;
}

/** loadConfig's message for an invalid config, as text. */
function loadError(raw: unknown): string {
	try {
		loadConfig(writeConfig(raw));
	} catch (err) {
		return (err as Error).message;
	}
	return "(loaded)";
}

/** parseConfigLib's message for the same raw object, as text. */
function libError(raw: unknown): string {
	try {
		parseConfigLib(raw);
	} catch (err) {
		return (err as Error).message;
	}
	return "(parsed)";
}

beforeAll(() => {
	mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

describe("parseConfigLib — same accepted values as loadConfig", () => {
	it("over a plain config, deep-equals the lib fields loadConfig returns", () => {
		const raw = { ...baseConfig(), defaultOwner: "CLDMV", app: { appId: 7, privateKey: "cred:app" } };
		const loaded = loadConfig(writeConfig(raw));
		expect(parseConfigLib(raw)).toEqual(libOf(loaded));
	});

	it("over a config with npm and ghcr, deep-equals the lib fields loadConfig returns", () => {
		const raw = {
			...baseConfig(),
			npm: { token: "cred:npm-token", scopes: ["@cldmv"], registry: "https://registry.npmjs.org", tokenOrgs: ["cldmv"] },
			ghcr: { dropDir: "/srv/gh-broker/ghcr-drop", owners: { cldmv: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot"] } } }
		};
		const loaded = loadConfig(writeConfig(raw));
		expect(parseConfigLib(raw)).toEqual(libOf(loaded));
	});

	it("over config.example.json with an owner added, deep-equals the lib fields loadConfig returns", () => {
		const raw = { ...JSON.parse(readFileSync(join(process.cwd(), "config.example.json"), "utf8")), owners: { acme: { read: "cred:acme-read", write: "cred:acme-write" } } };
		const loaded = loadConfig(writeConfig(raw));
		expect(parseConfigLib(raw)).toEqual(libOf(loaded));
	});

	it("over config.sample.json merged onto the example tools, deep-equals the lib fields loadConfig returns", () => {
		const example = JSON.parse(readFileSync(join(process.cwd(), "config.example.json"), "utf8"));
		const sample = JSON.parse(readFileSync(join(process.cwd(), "config.sample.json"), "utf8"));
		const raw = { ...sample, tools: example.tools };
		const loaded = loadConfig(writeConfig(raw));
		expect(parseConfigLib(raw)).toEqual(libOf(loaded));
	});

	it("carries the per-tool otp gating flags through exactly as loadConfig does", () => {
		const raw = { ...baseConfig(), tools: [{ name: "get_me", mode: "read" }, { name: "a", mode: "write", otp: true }, { name: "b", mode: "write", otp: false }] };
		const loaded = loadConfig(writeConfig(raw));
		expect(parseConfigLib(raw).tools).toEqual(loaded.tools);
	});
});

describe("parseConfigLib — the daemon-only fields are not its business", () => {
	it("ignores listen, upstream, secrets and otp entirely (garbage in them still parses)", () => {
		const raw = {
			...baseConfig(),
			listen: "tcp:0.0.0.0:9000",
			upstream: "not a url",
			secrets: { provider: "vault", path: "" },
			otp: { seed: "GEZDGNBV", windowSeconds: -1 }
		};
		expect(parseConfigLib(raw)).toEqual(parseConfigLib(baseConfig()));
	});

	it("reports nothing about them: their errors stay loadConfig's", () => {
		const bad = { ...baseConfig(), listen: "agents:relative", upstream: 42, secrets: [], otp: {} };
		expect(libError(bad)).toBe("(parsed)");
		expect(loadError(bad)).toMatch(/^config\.listen: must be "agents:<absolute directory>"/);
	});
});

describe("parseConfigLib — same error texts as loadConfig", () => {
	it("throws the root check loadConfig throws", () => {
		expect(libError("123")).toBe(loadError("123"));
		expect(libError(null)).toBe(loadError("null"));
	});

	it.each([
		["tools missing", { tools: undefined, owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["tools empty", { tools: [], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["tool with no name", { tools: [{ mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["bad tool mode", { tools: [{ name: "get_me", mode: "admin" }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["duplicate tool", { tools: [{ name: "get_me", mode: "read" }, { name: "get_me", mode: "write" }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["denylisted tool", { tools: [{ name: "push_files", mode: "write", otp: true }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["custom and augment", { tools: [{ name: "weird", mode: "read", custom: true, augment: true }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["non-boolean otp flag", { tools: [{ name: "a", mode: "write", otp: "yes" }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["gated otp_status", { tools: [{ name: "otp_status", mode: "read", custom: true, otp: true }], owners: { c: { read: "cred:r", write: "cred:w" } } }],
		["owners not an object", { tools: [{ name: "get_me", mode: "read" }], owners: "cldmv" }],
		["owner missing write", { tools: [{ name: "get_me", mode: "read" }], owners: { cldmv: { read: "cred:x" } } }],
		["bad installationId", { tools: [{ name: "get_me", mode: "read" }], owners: { cldmv: { read: "cred:r", write: "cred:w", installationId: "42" } } }],
		["empty owners", { tools: [{ name: "get_me", mode: "read" }], owners: {} }],
		["empty defaultOwner", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, defaultOwner: "" }],
		["unknown defaultOwner", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, defaultOwner: "nobody" }],
		["bad appId", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, app: { appId: "1", privateKey: "cred:app" } }],
		["bad privateKey", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, app: { appId: 1, privateKey: 5 } }],
		["npm not an object", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: [] }],
		["npm inline token", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: { token: "npm_inline_secret", scopes: ["@cldmv"] } }],
		["npm empty scopes", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: { token: "cred:npm-token", scopes: [] } }],
		["npm uppercase scope", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: { token: "cred:npm-token", scopes: ["@CLDMV"] } }],
		["npm http registry", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: { token: "cred:npm-token", scopes: ["@cldmv"], registry: "http://registry.npmjs.org" } }],
		["npm bad tokenOrgs", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, npm: { token: "cred:npm-token", scopes: ["@cldmv"], tokenOrgs: ["@cldmv"] } }],
		["ghcr dropDir under /etc", { tools: [{ name: "get_me", mode: "read" }], owners: { c: { read: "cred:r", write: "cred:w" } }, ghcr: { dropDir: "/etc/x/y", owners: { c: { username: "u", credential: "cred:c", images: ["i"] } } } }]
	])("parses like loadConfig: %s", (_name, patch) => {
		const raw = { ...baseConfig(), ...patch };
		expect(libError(raw)).toBe(loadError(raw));
	});
});

describe("parseConfigLib — loadConfig keeps today's validation order", () => {
	it("secrets errors beat npm errors (secrets is validated between app and npm)", () => {
		const raw = { ...baseConfig(), secrets: { provider: "vault" }, npm: { token: "nope", scopes: [] } };
		expect(loadError(raw)).toMatch(/config\.secrets\.provider/);
	});

	it("npm errors beat otp errors, and otp errors beat ghcr errors", () => {
		const raw = { ...baseConfig(), npm: { token: "nope" }, otp: { seed: "GEZDGNBV" }, ghcr: { dropDir: "/etc/x/y" } };
		expect(loadError(raw)).toMatch(/config\.npm\.token/);
		const raw2 = { ...baseConfig(), otp: { seed: "GEZDGNBV" }, ghcr: { dropDir: "/etc/x/y" } };
		expect(loadError(raw2)).toMatch(/config\.otp\.seed/);
	});

	it("lib-field errors beat the daemon-only fields that come after them", () => {
		const raw = { ...baseConfig(), owners: {}, secrets: { provider: "vault" } };
		expect(loadError(raw)).toMatch(/config\.owners: at least one owner required/);
	});
});
