import { describe, it, expect } from "vitest";
import { mergeConfig, layerConfig, overlayFromFlags, readOperatorConfig, buildConfig, secretsBlock, DEFAULT_GHCR_DROP_DIR } from "../deploy/lib/config-merge.mjs";

const example = {
	listen: "unix:/run/gh-broker/gh-broker.sock",
	upstream: "https://api.githubcopilot.com/mcp/x/all",
	tools: [
		{ name: "get_me", mode: "read" },
		{ name: "list_issues", mode: "read" }
	],
	owners: { acme: { read: "cred:acme-read", write: "cred:acme-write" } },
	defaultOwner: "acme"
};

describe("mergeConfig", () => {
	it("uses the example as-is on first install (no current)", () => {
		expect(mergeConfig(example, null)).toEqual(example);
	});

	it("takes tools from the example so allowlist removals/tightenings apply", () => {
		const current = { ...example, tools: [{ name: "get_me", mode: "read" }, { name: "removed_tool", mode: "write" }] };
		const merged = mergeConfig(example, current);
		expect(merged.tools).toEqual(example.tools);
		expect(merged.tools.find((t: { name: string }) => t.name === "removed_tool")).toBeUndefined();
	});

	it("preserves current owner data and adds example-only owners on upgrade", () => {
		const current = { ...example, owners: { acme: { read: "cred:acme-read", write: "cred:acme-write", installationId: 123 } } };
		const example2 = {
			...example,
			owners: {
				acme: { read: "cred:acme-read", write: "cred:acme-write" },
				beta: { read: "cred:beta-read", write: "cred:beta-write" }
			}
		};
		const merged = mergeConfig(example2, current);
		expect(merged.owners.acme.installationId).toBe(123); // current wins
		expect(merged.owners.beta).toBeDefined(); // new example owner appears
	});

	it("lets current win for listen/upstream/defaultOwner/app/secrets", () => {
		const current = { ...example, listen: "unix:/tmp/custom.sock", app: { appId: 1, privateKey: "cred:k" } };
		const merged = mergeConfig(example, current);
		expect(merged.listen).toBe("unix:/tmp/custom.sock");
		expect(merged.app).toEqual({ appId: 1, privateKey: "cred:k" });
	});

	it("keeps the current npm block on upgrade (the example has none)", () => {
		const npm = { token: "cred:npm-token", scopes: ["@cldmv"] };
		expect(mergeConfig(example, { ...example, npm }).npm).toEqual(npm);
		expect(mergeConfig(example, { ...example }).npm).toBeUndefined();
	});

	it("keeps the example's scalars when current omits them, and tolerates configs with no owners", () => {
		const merged = mergeConfig({ tools: [], listen: "unix:/a" }, { tools: [] });
		expect(merged.listen).toBe("unix:/a");
		expect(merged.owners).toEqual({});
	});

	it("does not mutate its inputs", () => {
		const ex = structuredClone(example);
		mergeConfig(ex, { ...example, listen: "unix:/z" });
		expect(ex).toEqual(example);
	});

	it("rejects an array as example or current (typeof reports 'object')", () => {
		expect(() => mergeConfig([], null)).toThrow(/example config must be an object/);
		expect(() => mergeConfig(example, [])).toThrow(/current config must be an object/);
	});

	describe("ghcr", () => {
		const ghcr = { dropDir: "/srv/gh-broker/ghcr-drop", owners: { cldmv: { username: "u", credential: "cred:p", images: ["hoot"] } } };

		it("keeps the deployed ghcr block (operator data); the example ships none", () => {
			expect(mergeConfig(example, { ...example, ghcr }).ghcr).toEqual(ghcr);
			expect(mergeConfig(example, { ...example }).ghcr).toBeUndefined();
		});

		it("lets the deployed ghcr win over one the example carries", () => {
			const edited = { ...ghcr, dropDir: "/srv/other/drop" };
			expect(mergeConfig({ ...example, ghcr }, { ...example, ghcr: edited }).ghcr).toEqual(edited);
			expect(mergeConfig({ ...example, ghcr }, example).ghcr).toEqual(ghcr);
		});
	});
});

const shipped = {
	listen: "unix:/run/gh-broker/gh-broker.sock",
	upstream: "https://api.githubcopilot.com/mcp/x/all",
	tools: [{ name: "get_me", mode: "read" }]
};
const noOpts = {};
const ask = async () => {
	throw new Error("unexpected prompt");
};

describe("layerConfig", () => {
	it("replaces scalars and merges owners per owner and per field", () => {
		const base = { listen: "unix:/a", upstream: "https://a", owners: { acme: { read: "cred:acme-read", write: "cred:acme-write", installationId: 7 } } };
		const out = layerConfig(base, { listen: "unix:/b", defaultOwner: "acme", owners: { acme: { write: "cred:w2" }, beta: { read: "cred:r", write: "cred:w" } } });
		expect(out.listen).toBe("unix:/b");
		expect(out.upstream).toBe("https://a");
		expect(out.defaultOwner).toBe("acme");
		expect(out.owners.acme).toEqual({ read: "cred:acme-read", write: "cred:w2", installationId: 7 });
		expect(out.owners.beta).toEqual({ read: "cred:r", write: "cred:w" });
		expect(base.owners.acme.write).toBe("cred:acme-write"); // input untouched
	});

	it("merges app/secrets/npm per field and creates them when absent", () => {
		const out = layerConfig({ npm: { token: "cred:t", scopes: ["@a"] } }, { npm: { registry: "https://r" }, secrets: { path: "/p" }, app: { appId: 1, privateKey: "cred:k" } });
		expect(out.npm).toEqual({ token: "cred:t", scopes: ["@a"], registry: "https://r" });
		expect(out.secrets).toEqual({ path: "/p" });
		expect(out.app).toEqual({ appId: 1, privateKey: "cred:k" });
	});

	it("merges ghcr scalars and ghcr owners per owner", () => {
		const base = { owners: {}, ghcr: { dropDir: "/srv/a/b", owners: { acme: { username: "u", credential: "cred:acme-packages", images: ["x"] } } } };
		const out = layerConfig(base, { ghcr: { protectReleaseTags: false, owners: { acme: { images: ["y"] }, beta: { username: "b", credential: "cred:beta-packages", images: ["z"] } } } });
		expect(out.ghcr.dropDir).toBe("/srv/a/b");
		expect(out.ghcr.protectReleaseTags).toBe(false);
		expect(out.ghcr.owners.acme).toEqual({ username: "u", credential: "cred:acme-packages", images: ["y"] });
		expect(Object.keys(out.ghcr.owners)).toEqual(["acme", "beta"]);
		expect(layerConfig({}, { ghcr: { dropDir: "/srv/a/b" } }).ghcr).toEqual({ dropDir: "/srv/a/b" });
	});

	it("leaves a base without overlay data alone", () => {
		expect(layerConfig({ listen: "unix:/a" }, {})).toEqual({ listen: "unix:/a" });
	});
});

describe("overlayFromFlags", () => {
	it("is empty with no flags", () => {
		expect(overlayFromFlags(noOpts)).toEqual({});
	});

	it("maps every flag to its config field", () => {
		const o = overlayFromFlags({
			listen: "unix:/x.sock",
			upstream: "https://u",
			defaultOwner: "acme",
			owners: ["acme", "beta"],
			installationIds: { acme: 42, gamma: 9 },
			appId: 5,
			appPrivateKey: "my-key",
			secretsPath: "/s.json",
			ghcrOwner: "acme",
			ghcrUsername: "me",
			ghcrImages: ["app", "app-*"],
			ghcrDropDir: "/srv/x/drop",
			ghcrMaxArchiveBytes: 1024,
			protectReleaseTags: false
		});
		expect(o).toEqual({
			listen: "unix:/x.sock",
			upstream: "https://u",
			defaultOwner: "acme",
			owners: {
				acme: { read: "cred:acme-read", write: "cred:acme-write", installationId: 42 },
				beta: { read: "cred:beta-read", write: "cred:beta-write" },
				gamma: { installationId: 9 }
			},
			app: { appId: 5, privateKey: "cred:my-key" },
			secrets: { path: "/s.json" },
			ghcr: {
				dropDir: "/srv/x/drop",
				maxArchiveBytes: 1024,
				protectReleaseTags: false,
				owners: { acme: { username: "me", credential: "cred:acme-packages", images: ["app", "app-*"] } }
			}
		});
	});

	it("derives the App key name when only --app-id is given and handles --protect-release-tags", () => {
		expect(overlayFromFlags({ appId: 5 }).app).toEqual({ appId: 5, privateKey: "cred:gh-app-key" });
		expect(overlayFromFlags({ protectReleaseTags: true }).ghcr).toEqual({ protectReleaseTags: true });
	});
});

describe("readOperatorConfig", () => {
	const read = (text: string) => () => text;

	it("returns a valid operator config", () => {
		const cfg = { listen: "unix:/a", owners: { acme: { read: "cred:acme-read", write: "cred:acme-write" } } };
		expect(readOperatorConfig("/c.json", read(JSON.stringify(cfg)))).toEqual(cfg);
	});

	it("reports an unreadable file and bad JSON", () => {
		expect(() =>
			readOperatorConfig("/missing.json", () => {
				throw new Error("ENOENT: no such file");
			})
		).toThrow(/--config: cannot read\/parse \/missing.json: ENOENT/);
		expect(() => readOperatorConfig("/c.json", read("{ nope"))).toThrow(/--config: cannot read\/parse/);
	});

	it("refuses a non-object root, tools, and unknown keys", () => {
		expect(() => readOperatorConfig("/c.json", read("[]"))).toThrow(/must be a JSON object/);
		expect(() => readOperatorConfig("/c.json", read("null"))).toThrow(/must be a JSON object/);
		expect(() => readOperatorConfig("/c.json", read('{"tools":[]}'))).toThrow(/`tools` is the shipped allowlist/);
		expect(() => readOperatorConfig("/c.json", read('{"lisen":"x","owners":{}}'))).toThrow(/unknown key\(s\) lisen/);
	});

	it.each([
		["a classic PAT", { owners: { acme: { read: "ghp_" + "a".repeat(36), write: "cred:w" } } }, "owners.acme.read"],
		["a fine-grained PAT", { ghcr: { owners: { a: { images: ["github_pat_" + "A1".repeat(20)] } } } }, "ghcr.owners.a.images[0]"],
		["an npm token", { npm: { token: "npm_" + "b".repeat(36), scopes: [] } }, "npm.token"],
		["a token as a list entry", { npm: { scopes: ["ok", "ghs_" + "c".repeat(30)] } }, "npm.scopes[1]"]
	])("refuses %s", (_name, cfg, where) => {
		expect(() => readOperatorConfig("/c.json", read(JSON.stringify(cfg)))).toThrow(new RegExp(`--config: ${where.replace(/[[\]]/g, "\\$&")} looks like a token`));
	});

	it("accepts cred refs, numbers and booleans alongside strings", () => {
		const cfg = { app: { appId: 1, privateKey: "cred:gh-app-key" }, ghcr: { protectReleaseTags: true } };
		expect(readOperatorConfig("/c.json", read(JSON.stringify(cfg)))).toEqual(cfg);
	});
});

describe("buildConfig", () => {
	const acme = { read: "cred:acme-read", write: "cred:acme-write" };
	const build = (o: Record<string, unknown>) => buildConfig({ example: shipped, current: null, file: undefined, opts: noOpts, nonInteractive: true, ask, ...o } as never);

	it("a first install takes owners from flags, defaults defaultOwner and sets ghcr.dropDir", async () => {
		const { config, notes } = await build({
			opts: { owners: ["acme"], ghcrOwner: "acme", ghcrUsername: "me", ghcrImages: ["app"] }
		});
		expect(config.tools).toEqual(shipped.tools);
		expect(config.owners).toEqual({ acme });
		expect(config.defaultOwner).toBe("acme");
		expect(config.ghcr).toEqual({ dropDir: DEFAULT_GHCR_DROP_DIR, owners: { acme: { username: "me", credential: "cred:acme-packages", images: ["app"] } } });
		expect(notes).toHaveLength(2);
	});

	it("does not pick a defaultOwner with several owners, or when one is set", async () => {
		expect((await build({ opts: { owners: ["acme", "beta"] } })).config.defaultOwner).toBeUndefined();
		expect((await build({ opts: { owners: ["acme", "beta"], defaultOwner: "beta" } })).config.defaultOwner).toBe("beta");
	});

	it("layers example < deployed < --config < flags", async () => {
		const current = { ...shipped, listen: "unix:/deployed", upstream: "https://deployed", owners: { acme }, defaultOwner: "acme" };
		const file = { listen: "unix:/file", upstream: "https://file" };
		const flags = { listen: "unix:/flag" };
		const { config } = await build({ current, file, opts: flags });
		expect(config.listen).toBe("unix:/flag"); // flag beats file
		expect(config.upstream).toBe("https://file"); // file beats deployed
		const deployedOnly = await build({ current });
		expect(deployedOnly.config.listen).toBe("unix:/deployed"); // deployed beats example
		expect(deployedOnly.config.upstream).toBe("https://deployed");
		expect((await build({ current: { tools: [], owners: { acme } } })).config.listen).toBe(shipped.listen); // example fills gaps
	});

	it("keeps the deployed owners, ghcr and tools on an upgrade with no flags", async () => {
		const ghcr = { dropDir: "/srv/old/drop", protectReleaseTags: false, maxArchiveBytes: 5, owners: { acme: { username: "me", credential: "cred:acme-packages", images: ["x"] } } };
		const current = { ...shipped, tools: [{ name: "gone", mode: "write" }], owners: { acme: { ...acme, installationId: 3 } }, ghcr };
		const { config, notes } = await build({ current });
		expect(config.owners).toEqual({ acme: { ...acme, installationId: 3 } });
		expect(config.ghcr).toEqual(ghcr);
		expect(config.tools).toEqual(shipped.tools); // allowlist from the example
		expect(config.defaultOwner).toBeUndefined();
		expect(notes).toEqual([]);
	});

	it("adds an owner on top of a deployed one without losing it", async () => {
		const { config } = await build({ current: { ...shipped, owners: { acme: { ...acme, installationId: 3 } } }, opts: { owners: ["acme", "beta"] } });
		expect(config.owners.acme.installationId).toBe(3);
		expect(config.owners.beta).toEqual({ read: "cred:beta-read", write: "cred:beta-write" });
	});

	it("takes owners, ghcr and defaultOwner from a --config file", async () => {
		const file = { owners: { acme }, defaultOwner: "acme", ghcr: { dropDir: "/srv/f/drop", owners: { acme: { username: "me", credential: "cred:acme-packages", images: ["a"] } } } };
		const { config } = await build({ file });
		expect(config.owners).toEqual({ acme });
		expect(config.ghcr.dropDir).toBe("/srv/f/drop");
	});

	it("fails non-interactively when no owner exists anywhere, naming --owner and --config", async () => {
		await expect(build({})).rejects.toThrow(/--owner <org>.*--config/);
		await expect(build({ current: { ...shipped } })).rejects.toThrow(/no GitHub owner configured/);
	});

	it("asks for the owner on an interactive first install", async () => {
		const asked: string[] = [];
		const { config } = await build({
			nonInteractive: false,
			ask: async (q: string) => {
				asked.push(q);
				return "  Acme-Corp \n";
			}
		});
		expect(asked).toHaveLength(1);
		expect(config.owners).toEqual({ "acme-corp": { read: "cred:acme-corp-read", write: "cred:acme-corp-write" } });
		expect(config.defaultOwner).toBe("acme-corp");
	});

	it("rejects an invalid owner typed at the prompt", async () => {
		await expect(build({ nonInteractive: false, ask: async () => "not an org!" })).rejects.toThrow(/not a valid GitHub owner name/);
		await expect(build({ nonInteractive: false, ask: async () => "" })).rejects.toThrow(/not a valid GitHub owner name/);
	});

	it("does not prompt when owners are already configured", async () => {
		const { config } = await build({ nonInteractive: false, current: { ...shipped, owners: { acme } } });
		expect(Object.keys(config.owners)).toEqual(["acme"]);
	});

	it("refuses an owner that has no credentials (e.g. --installation-id for an unknown owner)", async () => {
		await expect(build({ opts: { owners: ["acme"], installationIds: { gamma: 9 } } })).rejects.toThrow(/owner "gamma" has no credentials.*--owner gamma/);
	});

	it("keeps an explicit ghcr.dropDir instead of the default", async () => {
		const { config, notes } = await build({ opts: { owners: ["acme"], ghcrOwner: "acme", ghcrUsername: "me", ghcrImages: ["a"], ghcrDropDir: "/srv/mine/drop" } });
		expect(config.ghcr.dropDir).toBe("/srv/mine/drop");
		expect(notes.some((n: string) => n.includes("dropDir"))).toBe(false);
	});
});

describe("secretsBlock", () => {
	it("returns just the provider, keeping a path only for the file provider", () => {
		expect(secretsBlock("systemd-creds", undefined)).toEqual({ provider: "systemd-creds" });
		expect(secretsBlock("file", { path: "/s.json" })).toEqual({ provider: "file", path: "/s.json" });
		expect(secretsBlock("file", {})).toEqual({ provider: "file" });
	});

	it("refuses a path with the systemd-creds provider", () => {
		expect(() => secretsBlock("systemd-creds", { path: "/s.json" })).toThrow(/only used by the "file" provider/);
	});
});
