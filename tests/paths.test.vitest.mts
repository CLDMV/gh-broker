import { describe, it, expect, beforeEach, vi } from "vitest";
import { configDir, resolveConfigPath, resolveSecretsPath } from "../src/paths.ts";

describe("paths", () => {
	beforeEach(() => {
		// The imported `env` binding is the live process.env object, so mutating keys
		// (not reassigning) is reflected. Clear the ones under test.
		delete process.env.GH_BROKER_CONFIG;
		delete process.env.GH_BROKER_SECRETS;
		delete process.env.GH_BROKER_CONFIG_DIR;
	});

	it("configDir defaults to /etc/gh-broker on linux (the test host)", () => {
		expect(configDir()).toBe("/etc/gh-broker");
	});

	it("configDir honors the GH_BROKER_CONFIG_DIR override", () => {
		process.env.GH_BROKER_CONFIG_DIR = "/opt/cfg";
		expect(configDir()).toBe("/opt/cfg");
	});

	it("resolveConfigPath precedence: explicit > env > default", () => {
		expect(resolveConfigPath("/explicit.json")).toBe("/explicit.json");
		process.env.GH_BROKER_CONFIG = "/env.json";
		expect(resolveConfigPath()).toBe("/env.json");
		delete process.env.GH_BROKER_CONFIG;
		expect(resolveConfigPath()).toBe("/etc/gh-broker/config.json");
	});

	it("resolveSecretsPath precedence: explicit > env > default", () => {
		expect(resolveSecretsPath("/explicit-s.json")).toBe("/explicit-s.json");
		process.env.GH_BROKER_SECRETS = "/env-s.json";
		expect(resolveSecretsPath()).toBe("/env-s.json");
		delete process.env.GH_BROKER_SECRETS;
		expect(resolveSecretsPath()).toBe("/etc/gh-broker/secrets.json");
	});

	it("configDir maps darwin and win32 platforms", async () => {
		vi.resetModules();
		vi.doMock("node:process", () => ({ platform: "darwin", env: {} }));
		const mac = await import("../src/paths.ts");
		expect(mac.configDir()).toBe("/Library/Application Support/gh-broker");

		vi.resetModules();
		vi.doMock("node:process", () => ({ platform: "win32", env: { ProgramData: "C:/PD" } }));
		const win = await import("../src/paths.ts");
		expect(win.configDir()).toContain("gh-broker");

		vi.doUnmock("node:process");
		vi.resetModules();
	});
});
