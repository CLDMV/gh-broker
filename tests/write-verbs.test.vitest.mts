import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { minimizeComment, MINIMIZE_COMMENT_SCHEMA } from "../src/verbs/minimize_comment.ts";
import { deleteBranch, KEPT_BRANCHES, DELETE_BRANCH_SCHEMA } from "../src/verbs/delete_branch.ts";
import { dismissAlert, DISMISS_REASONS, DISMISS_ALERT_DESCRIPTION, DISMISS_ALERT_SCHEMA } from "../src/verbs/dismiss_alert.ts";
import { DENIED_TOOLS, deniedReason } from "../src/denylist.ts";

const octo = (request = vi.fn(), graphql = vi.fn()) => ({ octokit: { request, graphql } as any, request, graphql });

describe("minimize_comment", () => {
	it("hides a comment by node id as RESOLVED by default", async () => {
		const { octokit, graphql, request } = octo(vi.fn(), vi.fn(async () => ({ minimizeComment: { minimizedComment: { isMinimized: true, minimizedReason: "resolved" } } })));
		expect(await minimizeComment(octokit, { owner: "cldmv", commentId: "IC_1" })).toEqual({ commentId: "IC_1", isMinimized: true, minimizedReason: "resolved" });
		expect(graphql).toHaveBeenCalledWith(expect.stringContaining("minimizeComment"), { id: "IC_1", classifier: "RESOLVED" });
		expect(request).not.toHaveBeenCalled();
	});

	it("looks the node id up from a REST id, for issue and review comments", async () => {
		const graphql = vi.fn(async () => ({ minimizeComment: { minimizedComment: { isMinimized: true } } }));
		const request = vi.fn(async (route: string) => ({ data: { node_id: route.includes("/pulls/") ? "PRRC_9" : "IC_9" } }));
		const { octokit } = octo(request, graphql);
		expect(await minimizeComment(octokit, { owner: "cldmv", repo: "r", commentNumber: 9, type: "issue", classifier: "OUTDATED" })).toEqual({ commentId: "IC_9", isMinimized: true, minimizedReason: null });
		expect(request).toHaveBeenLastCalledWith("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", { owner: "cldmv", repo: "r", comment_id: 9 });
		expect(graphql).toHaveBeenLastCalledWith(expect.any(String), { id: "IC_9", classifier: "OUTDATED" });
		await minimizeComment(octokit, { owner: "cldmv", repo: "r", commentNumber: 9, type: "review" });
		expect(request).toHaveBeenLastCalledWith("GET /repos/{owner}/{repo}/pulls/comments/{comment_id}", expect.any(Object));
	});

	it("shows a hidden comment again with unhide", async () => {
		const { octokit, graphql } = octo(vi.fn(), vi.fn(async () => ({ unminimizeComment: { unminimizedComment: { isMinimized: false, minimizedReason: null } } })));
		expect(await minimizeComment(octokit, { owner: "cldmv", commentId: "IC_1", unhide: true })).toEqual({ commentId: "IC_1", isMinimized: false, minimizedReason: null });
		expect(graphql).toHaveBeenCalledWith(expect.stringContaining("unminimizeComment"), { id: "IC_1" });
	});

	it("refuses bad input before calling GitHub", async () => {
		const { octokit, graphql, request } = octo();
		const bad: Array<[any, RegExp]> = [
			[{ commentId: "IC_1", classifier: "NOPE" }, /classifier must be one of/],
			[{ commentId: " " }, /commentId must be a comment node id/],
			[{ commentId: 5 }, /commentId must be a comment node id/],
			[{ commentId: "IC_1", commentNumber: 3 }, /not both/],
			[{}, /pass commentId \(node id\), or commentNumber/],
			[{ commentNumber: 0, type: "issue", repo: "r" }, /pass commentId/],
			[{ commentNumber: 3, repo: "r" }, /needs type "issue"/],
			[{ commentNumber: 3, type: "issue" }, /needs repo/]
		];
		for (const [input, err] of bad) await expect(minimizeComment(octokit, { owner: "cldmv", ...input })).rejects.toThrow(err);
		expect(graphql).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("errors when GitHub returns no node id or no comment", async () => {
		const noNode = octo(vi.fn(async () => ({ data: {} })));
		await expect(minimizeComment(noNode.octokit, { owner: "cldmv", repo: "r", commentNumber: 3, type: "issue" })).rejects.toThrow(/no node id for issue comment 3/);
		const empty = octo(vi.fn(), vi.fn(async () => ({})));
		await expect(minimizeComment(empty.octokit, { owner: "cldmv", commentId: "IC_1" })).rejects.toThrow(/no comment for "IC_1"/);
		await expect(minimizeComment(empty.octokit, { owner: "cldmv", commentId: "IC_1", unhide: true })).rejects.toThrow(/no comment for "IC_1"/);
	});

	it("advertises owner as the only required field", () => {
		expect(MINIMIZE_COMMENT_SCHEMA.required).toEqual(["owner"]);
	});
});

describe("delete_branch", () => {
	/** A repo with default branch master, `open` PR heads, and refs that exist. */
	function fakeRepo(opts: { open?: number[]; refs?: Record<string, unknown> } = {}) {
		return vi.fn(async (route: string, p: any) => {
			if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "trunk" } };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: (opts.open ?? []).map((number) => ({ number })) };
			if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: (opts.refs ?? { "heads/feat/x": { object: { sha: "abc123" } } })[p.ref] ?? [] };
			if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") return { data: undefined };
			throw new Error(`unexpected ${route}`);
		});
	}

	it("deletes a branch and says how to restore it", async () => {
		const request = fakeRepo();
		const { octokit } = octo(request);
		expect(await deleteBranch(octokit, { owner: "cldmv", repo: "r", branch: "refs/heads/feat/x" })).toEqual({ deleted: "feat/x", sha: "abc123", restore: "git push origin abc123:refs/heads/feat/x" });
		expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/pulls", { owner: "cldmv", repo: "r", state: "open", head: "cldmv:feat/x", per_page: 10 });
		expect(request).toHaveBeenLastCalledWith("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner: "cldmv", repo: "r", ref: "heads/feat/x" });
	});

	it("refuses the flow branches and the default branch without deleting anything", async () => {
		const request = fakeRepo();
		const { octokit } = octo(request);
		for (const branch of KEPT_BRANCHES) await expect(deleteBranch(octokit, { owner: "cldmv", repo: "r", branch })).rejects.toThrow(/the release flow depends on it/);
		await expect(deleteBranch(octokit, { owner: "cldmv", repo: "r", branch: "trunk" })).rejects.toThrow(/cldmv\/r's default branch/);
		expect(request.mock.calls.some(([route]) => route.startsWith("DELETE"))).toBe(false);
	});

	it("refuses a branch with an open PR, and one that doesn't exist", async () => {
		const withPr = octo(fakeRepo({ open: [12, 14] }));
		await expect(deleteBranch(withPr.octokit, { owner: "cldmv", repo: "r", branch: "feat/x" })).rejects.toThrow(/head of open PR #12, #14/);
		const missing = octo(fakeRepo());
		await expect(deleteBranch(missing.octokit, { owner: "cldmv", repo: "r", branch: "feat" })).rejects.toThrow(/no branch "feat" in cldmv\/r/);
		expect(missing.request.mock.calls.some(([route]) => route.startsWith("DELETE"))).toBe(false);
	});

	it("needs repo and branch", async () => {
		const { octokit, request } = octo();
		await expect(deleteBranch(octokit, { owner: "cldmv", branch: "x" } as any)).rejects.toThrow(/repo is required/);
		await expect(deleteBranch(octokit, { owner: "cldmv", repo: "r" } as any)).rejects.toThrow(/branch is required/);
		await expect(deleteBranch(octokit, { owner: "cldmv", repo: "r", branch: "refs/heads/" })).rejects.toThrow(/branch is required/);
		expect(request).not.toHaveBeenCalled();
		expect(DELETE_BRANCH_SCHEMA.required).toEqual(["owner", "repo", "branch"]);
	});
});

describe("dismiss_alert", () => {
	const answer = (data: unknown) => vi.fn(async () => ({ data }));

	it("dismisses a code scanning alert with its reason and comment", async () => {
		const request = answer({ number: 7, state: "dismissed", dismissed_reason: "false positive", html_url: "https://x/7" });
		const out = await dismissAlert(octo(request).octokit, { owner: "cldmv", repo: "r", kind: "code_scanning", alertNumber: 7, reason: "false positive", comment: "test fixture" });
		expect(out).toEqual({ kind: "code_scanning", number: 7, state: "dismissed", reason: "false positive", url: "https://x/7" });
		expect(request).toHaveBeenCalledWith("PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}", { owner: "cldmv", repo: "r", alert_number: 7, state: "dismissed", dismissed_reason: "false positive", dismissed_comment: "test fixture" });
	});

	it("dismisses and reopens a Dependabot alert", async () => {
		const request = answer({ number: 3, state: "dismissed", dismissed_reason: "not_used" });
		const { octokit } = octo(request);
		await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "dependabot", alertNumber: 3, reason: "not_used" });
		expect(request).toHaveBeenLastCalledWith("PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}", { owner: "cldmv", repo: "r", alert_number: 3, state: "dismissed", dismissed_reason: "not_used" });
		await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "dependabot", alertNumber: 3, reopen: true, comment: "ignored" });
		expect(request).toHaveBeenLastCalledWith(expect.any(String), { owner: "cldmv", repo: "r", alert_number: 3, state: "open" });
	});

	it("resolves a secret scanning alert and never returns the secret", async () => {
		const request = answer({ number: 2, state: "resolved", resolution: "revoked", html_url: "https://x/2", secret: "ghp_SHOULD_NOT_LEAK", secret_type: "github_pat" });
		const { octokit } = octo(request);
		const out = await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "secret_scanning", alertNumber: 2, reason: "revoked", comment: "rotated" });
		expect(out).toEqual({ kind: "secret_scanning", number: 2, state: "resolved", reason: "revoked", url: "https://x/2" });
		expect(JSON.stringify(out)).not.toContain("ghp_");
		expect(request).toHaveBeenLastCalledWith("PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}", { owner: "cldmv", repo: "r", alert_number: 2, state: "resolved", resolution: "revoked", resolution_comment: "rotated" });
		await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "secret_scanning", alertNumber: 2, reason: "wont_fix" });
		expect(request).toHaveBeenLastCalledWith(expect.any(String), { owner: "cldmv", repo: "r", alert_number: 2, state: "resolved", resolution: "wont_fix" });
		await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "secret_scanning", alertNumber: 2, reopen: true });
		expect(request).toHaveBeenLastCalledWith(expect.any(String), { owner: "cldmv", repo: "r", alert_number: 2, state: "open" });
		await dismissAlert(octokit, { owner: "cldmv", repo: "r", kind: "secret_scanning", alertNumber: 2, reopen: true, comment: "not fixed" });
		expect(request).toHaveBeenLastCalledWith(expect.any(String), { owner: "cldmv", repo: "r", alert_number: 2, state: "open", resolution_comment: "not fixed" });
	});

	it("fills gaps in GitHub's answer instead of guessing", async () => {
		const out = await dismissAlert(octo(answer({})).octokit, { owner: "cldmv", repo: "r", kind: "dependabot", alertNumber: 4, reason: "inaccurate" });
		expect(out).toEqual({ kind: "dependabot", number: 4, state: "unknown", reason: null, url: null });
	});

	it("refuses bad input before calling GitHub", async () => {
		const { octokit, request } = octo();
		const base = { owner: "cldmv", repo: "r", kind: "code_scanning", alertNumber: 1, reason: "won't fix" };
		const bad: Array<[any, RegExp]> = [
			[{ repo: "" }, /repo is required/],
			[{ kind: "npm" }, /kind must be one of/],
			[{ alertNumber: 0 }, /alertNumber must be a positive integer/],
			[{ alertNumber: 1.5 }, /alertNumber must be a positive integer/],
			[{ comment: 3 }, /comment must be a string/],
			[{ reopen: true }, /a reopen takes no reason/],
			[{ reason: undefined }, /reason is required for a code_scanning alert, one of: "false positive", "won't fix", "used in tests"/],
			[{ kind: "dependabot", reason: "won't fix" }, /reason is required for a dependabot alert/]
		];
		for (const [over, err] of bad) await expect(dismissAlert(octokit, { ...base, ...over })).rejects.toThrow(err);
		expect(request).not.toHaveBeenCalled();
	});

	it("names every kind's reasons in its description", () => {
		for (const reasons of Object.values(DISMISS_REASONS)) for (const r of reasons) expect(DISMISS_ALERT_DESCRIPTION).toContain(r);
		expect(DISMISS_ALERT_SCHEMA.required).toEqual(["owner", "repo", "kind", "alertNumber"]);
	});
});

describe("deny list", () => {
	it("names the out-of-scope upstream tools exactly", () => {
		for (const name of ["create_or_update_file", "push_files", "delete_file", "delete_repository", "create_repository_ruleset", "custom_properties_write"]) {
			expect(DENIED_TOOLS.has(name)).toBe(true);
			expect(deniedReason(name)).toBe(DENIED_TOOLS.get(name));
		}
	});

	it("catches new tools of the same kinds by name", () => {
		const cases: Array<[string, RegExp]> = [
			["update_files", /git/],
			["push_commits", /git/],
			["delete_repo", /manual step/],
			["update_repository_ruleset", /rulesets/],
			["repository_ruleset_write", /rulesets/],
			["update_branch_protection", /branch protection/],
			["update_repository", /repo configuration/],
			["update_repository_settings", /repo configuration/],
			["actions_variable_write", /Actions variables/],
			["set_actions_secret", /Actions variables/],
			["update_workflow_permissions", /workflow permissions/],
			["bulk_close_issues", /bulk/],
			["lock_issue", /locking/],
			["unlock_conversation", /locking/]
		];
		for (const [name, why] of cases) expect(deniedReason(name), name).toMatch(why);
	});

	it("leaves every tool the broker ships alone, including repository_ruleset_read", () => {
		const shipped = (JSON.parse(readFileSync("config.example.json", "utf8")) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
		expect(shipped).toHaveLength(84);
		for (const name of [...shipped, "repository_ruleset_read", "create_branch"]) expect(deniedReason(name), name).toBeUndefined();
	});
});
