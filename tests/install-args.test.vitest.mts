import { describe, it, expect } from "vitest";
import { parseArgs, envSecretKey } from "../deploy/lib/install-args.mjs";

describe("parseArgs", () => {
	it("defaults", () => {
		expect(parseArgs([])).toEqual({ positional: [], nonInteractive: false, createAgentUser: false, npm: false, npmScopes: [], npmOrgs: [], cliSecrets: {} });
	});

	it("reads every flag", () => {
		const o = parseArgs([
			"repo",
			"-h",
			"-y",
			"--create-agent-user",
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
		[["--bogus"], /unknown flag: --bogus/]
	] as Array<[string[], RegExp]>)("refuses %j", (argv, msg) => {
		expect(() => parseArgs(argv)).toThrow(msg);
	});
});

describe("envSecretKey", () => {
	it("upper-cases and replaces non-alphanumerics", () => {
		expect(envSecretKey("npm-token")).toBe("GH_BROKER_SECRET_NPM_TOKEN");
		expect(envSecretKey("cldmv.read")).toBe("GH_BROKER_SECRET_CLDMV_READ");
	});
});
