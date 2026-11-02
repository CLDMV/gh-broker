import { describe, it, expect } from "vitest";
import { AGENT_USER, agentsDir, isAgentUser, parseAgentGroups } from "../src/agents.ts";

describe("agentsDir", () => {
	it("returns the absolute directory of an agents: listen value", () => {
		expect(agentsDir("agents:/run/gh-broker/agents")).toBe("/run/gh-broker/agents");
	});
	it("rejects other forms", () => {
		for (const v of ["unix:/run/x.sock", "agents:relative", "agents:", "/run/gh-broker/agents"]) expect(agentsDir(v)).toBeUndefined();
	});
});

describe("isAgentUser", () => {
	it("accepts Linux-style names up to 16 characters", () => {
		for (const n of ["repo", "glmtest", "_svc", "a-b_c9", "abcdefghijklmnop"]) expect(isAgentUser(n)).toBe(true);
	});
	it("refuses everything else, including __proto__, root and the service user", () => {
		for (const n of ["", "Repo", "9lives", "abcdefghijklmnopq", "a.b", "a b", "__proto__", "root", "gh-broker"]) expect(isAgentUser(n)).toBe(false);
		expect(AGENT_USER.test("__proto__")).toBe(true); // the pattern alone would allow it
	});
});

describe("parseAgentGroups", () => {
	it("finds every agent group with exactly gh-broker and its user as members", () => {
		const text = [
			"root:x:0:",
			"gh-broker:x:990:",
			"gh-broker-clients:x:991:gh-broker,repo",
			"gh-broker-agent-repo:x:1001:gh-broker,repo",
			"gh-broker-agent-glmtest:x:1002: repo-not-me , glmtest,gh-broker",
			"gh-broker-agent-glm:x:1003:glm, gh-broker",
			""
		].join("\n");
		const { agents, skipped } = parseAgentGroups(text);
		expect(agents).toEqual([
			{ user: "repo", group: "gh-broker-agent-repo", gid: 1001 },
			{ user: "glm", group: "gh-broker-agent-glm", gid: 1003 }
		]);
		expect(skipped).toEqual(["gh-broker-agent-glmtest: members must be exactly gh-broker and glmtest"]);
	});

	it("skips and reports malformed agent groups", () => {
		const text = [
			"gh-broker-agent-Bad:x:1:gh-broker,Bad",
			"gh-broker-agent-__proto__:x:2:gh-broker,__proto__",
			"gh-broker-agent-nogid:x::gh-broker,nogid",
			"gh-broker-agent-badgid:x:abc:gh-broker,badgid",
			"gh-broker-agent-alone:x:5:alone",
			"gh-broker-agent-nomembers:x:6",
			"gh-broker-agent-repo:x:7:gh-broker,repo,gh-broker"
		].join("\n");
		const { agents, skipped } = parseAgentGroups(text);
		expect(agents).toEqual([{ user: "repo", group: "gh-broker-agent-repo", gid: 7 }]);
		expect(skipped).toEqual([
			'gh-broker-agent-Bad: "Bad" is not a valid agent user name',
			'gh-broker-agent-__proto__: "__proto__" is not a valid agent user name',
			"gh-broker-agent-nogid: bad gid",
			"gh-broker-agent-badgid: bad gid",
			"gh-broker-agent-alone: members must be exactly gh-broker and alone",
			"gh-broker-agent-nomembers: members must be exactly gh-broker and nomembers"
		]);
	});
});
