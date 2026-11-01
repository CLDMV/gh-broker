import { describe, it, expect } from "vitest";
import { mergeConfig } from "../deploy/lib/config-merge.mjs";

const example = {
	listen: "unix:/run/gh-broker/gh-broker.sock",
	upstream: "https://api.githubcopilot.com/mcp/x/all",
	tools: [
		{ name: "get_me", mode: "read" },
		{ name: "list_issues", mode: "read" }
	],
	owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
	defaultOwner: "cldmv"
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
		const current = { ...example, owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write", installationId: 123 } } };
		const example2 = {
			...example,
			owners: {
				cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" },
				acme: { read: "cred:acme-read", write: "cred:acme-write" }
			}
		};
		const merged = mergeConfig(example2, current);
		expect(merged.owners.cldmv.installationId).toBe(123); // current wins
		expect(merged.owners.acme).toBeDefined(); // new example owner appears
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

		it("takes ghcr from the example (a security policy, like tools), ignoring a deployed edit", () => {
			const current = { ...example, ghcr: { ...ghcr, owners: { cldmv: { ...ghcr.owners.cldmv, images: ["*"] } } } };
			expect(mergeConfig({ ...example, ghcr }, current).ghcr).toEqual(ghcr);
		});

		it("adds ghcr on upgrade and drops it when the example no longer ships it", () => {
			expect(mergeConfig({ ...example, ghcr }, example).ghcr).toEqual(ghcr);
			expect(mergeConfig(example, { ...example, ghcr }).ghcr).toBeUndefined();
		});
	});
});
