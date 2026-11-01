import { describe, it, expect } from "vitest";
import { anyVulnerable, compareVersions, inRange, installedVersions, lockfileCandidates, lockfileKind } from "../src/verbs/lockfile.ts";

describe("lockfileKind / lockfileCandidates", () => {
	it("recognizes the npm-ecosystem lockfiles by basename", () => {
		expect(lockfileKind("package-lock.json")).toBe("npm");
		expect(lockfileKind("a/npm-shrinkwrap.json")).toBe("npm");
		expect(lockfileKind("a/b/pnpm-lock.yaml")).toBe("pnpm");
		expect(lockfileKind("yarn.lock")).toBe("yarn");
		expect(lockfileKind("package.json")).toBeUndefined();
	});

	it("uses a lockfile manifest as-is and walks up from a package.json", () => {
		expect(lockfileCandidates("packages/a/yarn.lock")).toEqual(["packages/a/yarn.lock"]);
		expect(lockfileCandidates("packages/a/package.json")).toEqual([
			"packages/a/package-lock.json",
			"packages/a/npm-shrinkwrap.json",
			"packages/a/pnpm-lock.yaml",
			"packages/a/yarn.lock",
			"packages/package-lock.json",
			"packages/npm-shrinkwrap.json",
			"packages/pnpm-lock.yaml",
			"packages/yarn.lock",
			"package-lock.json",
			"npm-shrinkwrap.json",
			"pnpm-lock.yaml",
			"yarn.lock"
		]);
		expect(lockfileCandidates("package.json")).toEqual(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
	});
});

describe("installedVersions", () => {
	it("reads npm v2/v3 flat packages, including nested copies and workspace names", () => {
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { name: "root", version: "1.0.0" },
				"node_modules/hono": { version: "4.1.0" },
				"node_modules/a/node_modules/hono": { version: "4.13.7" },
				"node_modules/hono-extra": { version: "9.9.9" },
				"packages/x": { name: "hono", version: "4.1.0" },
				"node_modules/linked": { link: true, version: "1.0.0" },
				"node_modules/nover": {}
			}
		});
		expect(installedVersions("npm", lock, "hono")).toEqual(["4.1.0", "4.13.7"]);
		expect(installedVersions("npm", lock, "linked")).toEqual([]);
		expect(installedVersions("npm", lock, "nover")).toEqual([]);
	});

	it("reads npm v1 nested dependencies", () => {
		const lock = JSON.stringify({
			lockfileVersion: 1,
			dependencies: {
				ws: { version: "7.0.0", dependencies: { ws: { version: "8.1.0" } } },
				other: { version: "1.0.0", dependencies: { ws: { version: "7.0.0" } } },
				broken: { dependencies: { ws: {} } }
			}
		});
		expect(installedVersions("npm", lock, "ws")).toEqual(["7.0.0", "8.1.0"]);
		expect(installedVersions("npm", JSON.stringify({}), "ws")).toEqual([]);
	});

	it("returns undefined for an npm lockfile that isn't JSON", () => {
		expect(installedVersions("npm", "{nope", "ws")).toBeUndefined();
	});

	it("reads pnpm v5, v6 and v9 package keys and ignores other sections", () => {
		const lock = [
			"lockfileVersion: '9.0'",
			"importers:",
			"  .:",
			"    dependencies:",
			"      ws:",
			"        specifier: ^8.0.0",
			"packages:",
			"  /ws/7.4.0:",
			"    resolution: {integrity: x}",
			"  /ws@8.0.0(bufferutil@4.0.0):",
			"  ws@8.17.1:",
			"  /ws/6.0.0_peer@1.0.0:",
			"  '@scope/pkg@2.0.0':",
			"  /@scope/pkg/1.0.0:",
			"  ws-extra@1.0.0:",
			"  ws@latest:",
			"  not a key line",
			"snapshots:",
			"  ws@9.9.9:"
		].join("\n");
		expect(installedVersions("pnpm", lock, "ws")).toEqual(["7.4.0", "8.0.0", "8.17.1", "6.0.0"]);
		expect(installedVersions("pnpm", lock, "@scope/pkg")).toEqual(["2.0.0", "1.0.0"]);
	});

	it("reads yarn classic and Berry entries, scoped names included", () => {
		const classic = [
			"# yarn lockfile v1",
			"",
			'ws@^7.0.0, ws@^7.1.0:',
			'  version "7.4.6"',
			'  resolved "https://x"',
			'"@scope/pkg@^1.0.0":',
			'  version "1.2.3"',
			"ws-extra@^1.0.0:",
			'  version "1.0.0"'
		].join("\n");
		expect(installedVersions("yarn", classic, "ws")).toEqual(["7.4.6"]);
		expect(installedVersions("yarn", classic, "@scope/pkg")).toEqual(["1.2.3"]);
		const berry = ["__metadata:", "  version: 6", "", '"ws@npm:^8.0.0, ws@npm:^8.1.0":', "  dependencies:", "  version: 8.17.1", "  resolution: x"].join("\n");
		expect(installedVersions("yarn", berry, "ws")).toEqual(["8.17.1"]);
	});
});

describe("compareVersions / inRange / anyVulnerable", () => {
	it("orders versions by semver precedence", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("v1.2.4", "1.2.3")).toBeGreaterThan(0);
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
		expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
		expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
		expect(compareVersions("1.0.0-beta", "1.0.0-1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-rc.1+build.5", "1.0.0-rc.1")).toBe(0);
		expect(compareVersions("latest", "1.0.0")).toBeUndefined();
		expect(compareVersions("1.0.0", "x")).toBeUndefined();
	});

	it("evaluates Dependabot comparator ranges", () => {
		expect(inRange("4.1.0", ">= 4.0.0, < 4.17.21")).toBe(true);
		expect(inRange("4.17.21", ">= 4.0.0, < 4.17.21")).toBe(false);
		expect(inRange("3.0.0", ">= 4.0.0, < 4.17.21")).toBe(false);
		expect(inRange("10.7.0", "<= 10.7.0")).toBe(true);
		expect(inRange("2.0.0", "> 1.0.0")).toBe(true);
		expect(inRange("1.0.0", "= 1.0.0")).toBe(true);
		expect(inRange("1.0.1", "1.0.0")).toBe(false);
		expect(inRange("1.0.0", "~> 1.0")).toBeUndefined();
		expect(inRange("1.0.0", "< 1 2")).toBeUndefined();
	});

	it("decides vulnerability from the range, falling back to the patched version", () => {
		expect(anyVulnerable(["4.1.0", "4.20.0"], "< 4.13.7", "4.13.7")).toBe(true);
		expect(anyVulnerable(["4.20.0"], "< 4.13.7", "4.13.7")).toBe(false);
		expect(anyVulnerable([], "< 4.13.7", "4.13.7")).toBe(false);
		expect(anyVulnerable(["4.1.0"], "weird range", "4.13.7")).toBe(true);
		expect(anyVulnerable(["4.20.0"], undefined, "4.13.7")).toBe(false);
		expect(anyVulnerable(["4.20.0"], undefined, undefined)).toBeUndefined();
		expect(anyVulnerable(["latest"], "< 4.13.7", "4.13.7")).toBeUndefined();
		expect(anyVulnerable(["latest", "1.0.0"], "< 4.13.7", "4.13.7")).toBe(true);
	});
});
