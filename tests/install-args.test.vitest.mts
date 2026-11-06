import { describe, it, expect } from "vitest";
import { parseArgs, envSecretKey } from "../src/cli/install-args.ts";

describe("parseArgs", () => {
	it("defaults", () => {
		expect(parseArgs([])).toEqual({ positional: [], nonInteractive: false, createAgentUser: false, noMcpConfig: false, npm: false, npmScopes: [], npmOrgs: [], cliSecrets: {} });
	});

	it("reads every flag", () => {
		const o = parseArgs([
			"repo",
			"-h",
			"-y",
			"--create-agent-user",
			"--no-mcp-config",
			"--agent-user",
			"agent",
			"--secrets-provider",
			"file",
			"--secrets-file",
			"/x/s.json",
			"--npm",
			"--npm-scope",
			"@cldmv",
			"--npm-scope",
			"@other",
			"--npm-org",
			"cldmv",
			"--npm-token-days",
			"30"
		]);
		expect(o).toEqual({
			positional: ["repo"],
			help: true,
			nonInteractive: true,
			createAgentUser: true,
			noMcpConfig: true,
			agentUser: "agent",
			provider: "file",
			secretsFile: "/x/s.json",
			npm: true,
			npmScopes: ["@cldmv", "@other"],
			npmOrgs: ["cldmv"],
			npmTokenDays: 30,
			cliSecrets: {}
		});
		expect(parseArgs(["--help", "--non-interactive"])).toMatchObject({ help: true, nonInteractive: true });
	});

	it("parses every config flag", () => {
		const o = parseArgs([
			"--config", "/etc/x.json",
			"--owner", "acme", "--owner", "beta",
			"--installation-id", "acme=42",
			"--default-owner", "acme",
			"--listen", "agents:/run/x",
			"--upstream", "https://example.test/mcp",
			"--app-id", "77",
			"--app-private-key", "cred:my-key",
			"--secrets-path", "/etc/s.json",
			"--npm", "--npm-registry", "https://registry.example.test",
			"--ghcr-owner", "acme", "--ghcr-username", "Me-1",
			"--ghcr-image", "app", "--ghcr-image", "app-*", "--ghcr-image", "team/svc",
			"--ghcr-drop-dir", "/srv/x/drop",
			"--ghcr-max-archive-bytes", "1048576",
			"--no-protect-release-tags"
		]);
		expect(o).toMatchObject({
			configFile: "/etc/x.json",
			owners: ["acme", "beta"],
			installationIds: { acme: 42 },
			defaultOwner: "acme",
			listen: "agents:/run/x",
			upstream: "https://example.test/mcp",
			appId: 77,
			appPrivateKey: "my-key",
			secretsPath: "/etc/s.json",
			npmRegistry: "https://registry.example.test",
			ghcrOwner: "acme",
			ghcrUsername: "Me-1",
			ghcrImages: ["app", "app-*", "team/svc"],
			ghcrDropDir: "/srv/x/drop",
			ghcrMaxArchiveBytes: 1048576,
			protectReleaseTags: false
		});
		expect(parseArgs(["--protect-release-tags"]).protectReleaseTags).toBe(true);
		expect(parseArgs(["--app-id", "5"]).appPrivateKey).toBeUndefined();
	});

	it("leaves the config fields unset when no config flag is given", () => {
		const o = parseArgs(["--agent-user", "a"]);
		for (const k of ["configFile", "owners", "defaultOwner", "listen", "upstream", "appId", "ghcrOwner", "protectReleaseTags"]) expect(o[k]).toBeUndefined();
	});

	it("collects --secret name=token pairs, keeping any = inside the token", () => {
		const o = parseArgs(["--secret", "cldmv-read=ghp_abc", "--secret", "npm-token=npm_x=y==", "--secret", "cldmv-read=ghp_new"]);
		expect(o.cliSecrets).toEqual({ "cldmv-read": "ghp_new", "npm-token": "npm_x=y==" });
	});

	it.each([
		[["--secret"], /--secret requires a value/],
		[["--secret", "novalue"], /--secret takes <cred-name>=<token>/],
		[["--secret", "=tok"], /--secret takes <cred-name>=<token>/],
		[["--secret", "name="], /--secret takes <cred-name>=<token>/],
		[["--secret", "../x=tok"], /unsafe credential name/],
		[["--agent-user", "--secrets-provider", "file"], /--agent-user requires a value/],
		[["--secrets-provider", "vault"], /--secrets-provider must be "systemd-creds" or "file"/],
		[["--npm-scope", "cldmv"], /--npm-scope must be a lowercase npm scope/],
		[["--npm-org", "@cldmv"], /--npm-org must be a lowercase npm org name/],
		[["--npm-token-days", "0"], /--npm-token-days must be a whole number of days/],
		[["--npm-token-days", "1.5"], /--npm-token-days must be a whole number of days/],
		[["--config"], /--config requires a value/],
		[["--config", "--owner"], /--config requires a value/],
		[["--owner", "Acme"], /--owner must be a lowercase GitHub owner name/],
		[["--owner", "-x"], /--owner requires a value/],
		[["--installation-id", "acme"], /--installation-id takes <owner>=<numeric id>/],
		[["--installation-id", "Acme=1"], /--installation-id takes/],
		[["--installation-id", "acme=0"], /--installation-id takes/],
		[["--installation-id", "=5"], /--installation-id takes/],
		[["--default-owner", "A_B"], /--default-owner must be a lowercase GitHub owner name/],
		[["--listen", "/run/x.sock"], /--listen must be an "agents:<absolute directory>"/],
		[["--upstream", "ftp://x"], /--upstream must be an http\(s\) URL/],
		[["--app-id", "abc"], /--app-id must be the numeric GitHub App id/],
		[["--app-private-key", "k"], /--app-private-key needs --app-id/],
		[["--app-id", "1", "--app-private-key", "../k"], /unsafe credential name/],
		[["--secrets-path", "rel.json"], /--secrets-path must be an absolute path/],
		[["--npm-registry", "https://r"], /--npm-registry only applies together with --npm/],
		[["--npm", "--npm-registry", "http://r"], /--npm-registry must be an https URL/],
		[["--ghcr-owner", "Acme"], /--ghcr-owner must be a lowercase GitHub owner name/],
		[["--ghcr-owner", "acme"], /--ghcr-owner needs --ghcr-username and at least one --ghcr-image/],
		[["--ghcr-owner", "acme", "--ghcr-username", "me"], /--ghcr-owner needs --ghcr-username/],
		[["--ghcr-owner", "acme", "--ghcr-image", "app"], /--ghcr-owner needs --ghcr-username/],
		[["--ghcr-username", "me"], /need --ghcr-owner/],
		[["--ghcr-image", "app"], /need --ghcr-owner/],
		[["--ghcr-username", "-bad"], /--ghcr-username requires a value/],
		[["--ghcr-username", "bad_name"], /--ghcr-username must be a GitHub login/],
		[["--ghcr-image", "Bad/IMG"], /--ghcr-image must be a lowercase image name/],
		[["--ghcr-image", "a".repeat(256)], /--ghcr-image must be a lowercase image name/],
		[["--ghcr-drop-dir", "drop"], /--ghcr-drop-dir must be an absolute path/],
		[["--ghcr-max-archive-bytes", "0"], /--ghcr-max-archive-bytes must be a positive whole number/],
		[["--ghcr-max-archive-bytes", "9999999999999999"], /--ghcr-max-archive-bytes must be a positive whole number/],
		[["--ghcr-max-archive-bytes", "1.5"], /--ghcr-max-archive-bytes must be a positive whole number/],
		[["--bogus"], /unknown flag: --bogus/]
	] as Array<[string[], RegExp]>)("refuses %j", (argv, msg) => {
		expect(() => parseArgs(argv)).toThrow(msg);
	});
});

describe("--claude-config (#163)", () => {
	it("takes <user>:<absolute folder>, repeatable, without a trailing slash", () => {
		expect(parseArgs(["--claude-config", "glmtest:/srv/claude/", "--claude-config", "repo:/x"]).claudeConfigs).toEqual([{ user: "glmtest", dir: "/srv/claude" }, { user: "repo", dir: "/x" }]);
		expect(parseArgs(["--claude-config", "repo:/"]).claudeConfigs).toEqual([{ user: "repo", dir: "/" }]);
	});
	it("refuses a missing user, a relative folder or a bad name", () => {
		expect(() => parseArgs(["--claude-config", "/srv/claude"])).toThrow('--claude-config takes <agent user>:<absolute folder>, got "/srv/claude"');
		expect(() => parseArgs(["--claude-config", ":/srv"])).toThrow(/takes <agent user>:<absolute folder>/);
		expect(() => parseArgs(["--claude-config", "repo:rel"])).toThrow(/takes <agent user>:<absolute folder>/);
		expect(() => parseArgs(["--claude-config", "Bad:/x"])).toThrow(/not a valid agent user name/);
		expect(() => parseArgs(["--claude-config"])).toThrow(/requires a value/);
	});
});

describe("envSecretKey", () => {
	it("upper-cases and replaces non-alphanumerics", () => {
		expect(envSecretKey("npm-token")).toBe("GH_BROKER_SECRET_NPM_TOKEN");
		expect(envSecretKey("cldmv.read")).toBe("GH_BROKER_SECRET_CLDMV_READ");
	});
});
