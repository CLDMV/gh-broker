import { describe, it, expect } from "vitest";
import * as a from "../deploy/lib/agents.mjs";

const GROUPS = `root:x:0:
gh-broker:x:985:
gh-broker-clients:x:984:gh-broker,repo,glmtest,Bad.Name,rummage
gh-broker-agent-repo:x:990:gh-broker,repo
gh-broker-agent-half:x:991:repo
gh-broker-agent-BAD:x:992:gh-broker,BAD
nogid
:x:1:
users:x:100:repo
`;

describe("names and paths", () => {
	it("validates agent user names (group name stays within 32 chars)", () => {
		for (const ok of ["repo", "_svc", "a", "glm-test_1", "a".repeat(16)]) expect(a.validAgentName(ok)).toBe(true);
		for (const bad of ["", "Repo", "1abc", "a".repeat(17), "a b", "../x", "a.b", undefined, 5]) expect(a.validAgentName(bad as string)).toBe(false);
		expect(a.assertAgentName("repo")).toBe("repo");
		expect(() => a.assertAgentName("Repo")).toThrow(/not a valid agent user name/);
		expect((a.AGENT_GROUP_PREFIX + "a".repeat(16)).length).toBeLessThanOrEqual(32);
	});

	it("derives the group, socket directory and socket path", () => {
		expect(a.agentGroup("repo")).toBe("gh-broker-agent-repo");
		expect(a.agentsDir("agents:/run/x/agents")).toBe("/run/x/agents");
		expect(a.agentsDir("unix:/run/gh-broker/gh-broker.sock")).toBe(a.DEFAULT_AGENTS_DIR);
		expect(a.agentsDir(undefined)).toBe(a.DEFAULT_AGENTS_DIR);
		expect(a.DEFAULT_LISTEN).toBe("agents:/run/gh-broker/agents");
		expect(a.socketPath("/run/x", "repo")).toBe("/run/x/repo.sock");
	});
});

describe("group file", () => {
	const groups = a.parseGroups(GROUPS);

	it("parses members, skipping malformed lines", () => {
		expect(groups.find((g) => g.name === "root")).toEqual({ name: "root", gid: 0, members: [] });
		expect(groups.find((g) => g.name === "gh-broker-agent-repo")).toEqual({ name: "gh-broker-agent-repo", gid: 990, members: ["gh-broker", "repo"] });
		expect(groups.some((g) => g.name === "nogid" || g.name === "")).toBe(false);
	});

	it("registers agents from complete-or-not groups with valid names, sorted", () => {
		expect(a.registeredAgents(groups)).toEqual([
			{ user: "half", gid: 991, complete: false },
			{ user: "repo", gid: 990, complete: true }
		]);
		expect(a.registeredAgents([])).toEqual([]);
	});

	it("plans the gh-broker-clients migration", () => {
		const plan = a.migrationPlan(groups, a.registeredAgents(groups));
		expect(plan.add).toEqual(["glmtest", "rummage"]);
		expect(plan.skipped).toEqual(["Bad.Name"]);
		expect(a.migrationPlan([{ name: "root", gid: 0, members: [] }], [])).toEqual({ add: [], skipped: [] });
	});
});

describe("passwd, install location, versions", () => {
	it("parses a getent passwd line", () => {
		expect(a.parsePasswd("repo:x:1003:1003:Repo:/home/repo:/bin/bash\n")).toEqual({ uid: 1003, gid: 1003, home: "/home/repo" });
		expect(a.parsePasswd("short:x:1")).toBeUndefined();
		expect(a.parsePasswd("u:x:a:b::/h:/bin/sh")).toBeUndefined();
		expect(a.parsePasswd("u:x:1:1::: /bin/sh")).toBeUndefined();
	});

	it("classifies where the package is installed", () => {
		expect(a.classifyInstall("/usr/local/lib/node_modules/@cldmv/gh-broker")).toBe("global");
		expect(a.classifyInstall("/home/x/.nvm/versions/node/v24/lib/node_modules/@cldmv/gh-broker")).toBe("nvm");
		expect(a.classifyInstall("/usr/local/nvm/versions/node/v24/lib/node_modules/@cldmv/gh-broker")).toBe("nvm");
		expect(a.classifyInstall("/srv/repos/gh-broker")).toBe("checkout");
	});

	it("warns only when the package and the deployed version differ", () => {
		expect(a.versionWarning("0.10.0", "0.9.0")).toContain('package is 0.10.0 but the deployed service is 0.9.0; run "sudo gh-broker install"');
		expect(a.versionWarning("0.9.0", "0.9.0")).toBeUndefined();
		expect(a.versionWarning("0.9.0", undefined)).toBeUndefined();
		expect(a.versionWarning(undefined, "0.9.0")).toBeUndefined();
		expect(a.NPM_INSTALL_COMMAND).toContain("--prefix /usr/local --ignore-scripts");
	});
});
