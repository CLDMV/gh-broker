import { describe, it, expect, vi, beforeEach } from "vitest";
import { issueLabels, ISSUE_LABELS_SCHEMA } from "../src/verbs/issue_labels.ts";

/**
 * A tiny in-memory GitHub: repo labels + one issue's labels, answering the REST routes
 * issue_labels uses the way GitHub does (case-insensitive names, 404 for an unknown
 * label or a label not on the issue, POST appends, PUT replaces, DELETE returns the rest).
 */
function fakeGitHub(repoLabels: string[], issueLabels: string[], opts: { issueExists?: boolean } = {}) {
	const repo = [...repoLabels];
	let issue = [...issueLabels];
	const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
	const find = (list: string[], n: string) => list.find((l) => l.toLowerCase() === String(n).toLowerCase());
	const asData = () => issue.map((name) => ({ name }));
	const request = vi.fn(async (route: string, p: any) => {
		if (route.includes("/issues/") && opts.issueExists === false) throw notFound();
		switch (route) {
			case "GET /repos/{owner}/{repo}/issues/{issue_number}/labels":
				return { data: asData() };
			case "GET /repos/{owner}/{repo}/labels/{name}": {
				const hit = find(repo, p.name);
				if (!hit) throw notFound();
				return { data: { name: hit } };
			}
			case "POST /repos/{owner}/{repo}/labels":
				repo.push(p.name);
				return { data: { name: p.name, color: p.color } };
			case "POST /repos/{owner}/{repo}/issues/{issue_number}/labels":
				for (const l of p.labels) if (!find(issue, l)) issue.push(l);
				return { data: asData() };
			case "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels":
				issue = [...p.labels];
				return { data: asData() };
			case "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}": {
				const hit = find(issue, p.name);
				if (!hit) throw notFound();
				issue = issue.filter((l) => l !== hit);
				return { data: asData() };
			}
			default:
				throw new Error(`unexpected route ${route}`);
		}
	});
	return { octokit: { request } as any, request, repo, get issue() { return issue; } };
}

const REPO = ["type: bug", "priority: high", "area: auth", "status: not started", "status: in progress", "status: implemented", "status: verified"];
const base = { owner: "cldmv", repo: "gh-broker", issue_number: 117 };
const writes = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map((c) => c[0] as string).filter((r) => !r.startsWith("GET "));

describe("issueLabels", () => {
	let gh: ReturnType<typeof fakeGitHub>;
	beforeEach(() => {
		gh = fakeGitHub(REPO, ["type: bug", "priority: high", "status: in progress"]);
	});

	it("add appends one label and leaves the rest alone", async () => {
		const out = await issueLabels(gh.octokit, { ...base, add: "area: auth" });
		expect(out.labels).toEqual(["type: bug", "priority: high", "status: in progress", "area: auth"]);
		expect(out).toMatchObject({ issue: "cldmv/gh-broker#117", added: ["area: auth"], removed: [], created: [] });
		expect(writes(gh.request)).toEqual(["POST /repos/{owner}/{repo}/issues/{issue_number}/labels"]);
	});

	it("add takes several labels; one already on the issue is a no-op", async () => {
		const out = await issueLabels(gh.octokit, { ...base, add: ["area: auth", "priority: high"] });
		expect(out.added).toEqual(["area: auth"]);
		expect(out.labels).toHaveLength(4);
	});

	it("add writes the repo's own spelling of a case-mismatched name", async () => {
		await issueLabels(gh.octokit, { ...base, add: "AREA: Auth" });
		const post = gh.request.mock.calls.find((c) => c[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels");
		expect(post?.[1].labels).toEqual(["area: auth"]);
	});

	it("remove deletes only the named labels; one the issue lacks is a no-op", async () => {
		const out = await issueLabels(gh.octokit, { ...base, remove: ["priority: high", "area: auth"] });
		expect(out.labels).toEqual(["type: bug", "status: in progress"]);
		expect(out.removed).toEqual(["priority: high"]);
	});

	it("remove of labels the issue doesn't have still returns the current set", async () => {
		const out = await issueLabels(gh.octokit, { ...base, remove: "area: auth" });
		expect(out.labels).toEqual(["type: bug", "priority: high", "status: in progress"]);
		expect(out.removed).toEqual([]);
	});

	it("remove does not require the label to exist in the repo", async () => {
		const out = await issueLabels(gh.octokit, { ...base, remove: "no such label" });
		expect(out.removed).toEqual([]);
	});

	it("add and remove combine in one call", async () => {
		const out = await issueLabels(gh.octokit, { ...base, add: "area: auth", remove: "priority: high" });
		expect(out.labels).toEqual(["type: bug", "status: in progress", "area: auth"]);
		expect(out).toMatchObject({ added: ["area: auth"], removed: ["priority: high"] });
	});

	it("swap replaces every label with the prefix and keeps the others", async () => {
		gh = fakeGitHub(REPO, ["type: bug", "status: not started", "priority: high", "status: in progress"]);
		const out = await issueLabels(gh.octokit, { ...base, swap: { prefix: "status: ", to: "status: verified" } });
		expect(out.labels).toEqual(["type: bug", "priority: high", "status: verified"]);
		expect(out.removed).toEqual(["status: not started", "status: in progress"]);
		expect(out.added).toEqual(["status: verified"]);
	});

	it("swap leaves a target label that is already present in place instead of re-adding it", async () => {
		gh = fakeGitHub(REPO, ["status: verified", "status: in progress"]);
		const out = await issueLabels(gh.octokit, { ...base, swap: { prefix: "Status: ", to: ["status: verified"] } });
		expect(out.labels).toEqual(["status: verified"]);
		expect(out.removed).toEqual(["status: in progress"]);
		expect(out.added).toEqual([]);
		const deletes = gh.request.mock.calls.filter((c) => String(c[0]).startsWith("DELETE"));
		expect(deletes.map((c) => c[1].name)).toEqual(["status: in progress"]);
	});

	it("swap combines with add and remove", async () => {
		const out = await issueLabels(gh.octokit, { ...base, swap: { prefix: "status: ", to: "status: implemented" }, add: "area: auth", remove: "type: bug" });
		expect(out.labels).toEqual(["priority: high", "area: auth", "status: implemented"]);
	});

	it("set replaces the whole set and reports the difference", async () => {
		const out = await issueLabels(gh.octokit, { ...base, set: ["type: bug", "status: verified"] });
		expect(out.labels).toEqual(["type: bug", "status: verified"]);
		expect(out.added).toEqual(["status: verified"]);
		expect(out.removed).toEqual(["priority: high", "status: in progress"]);
		expect(writes(gh.request)).toEqual(["PUT /repos/{owner}/{repo}/issues/{issue_number}/labels"]);
	});

	it("refuses an unknown add-side label and writes nothing", async () => {
		await expect(issueLabels(gh.octokit, { ...base, add: ["area: auth", "staus: verified"] })).rejects.toThrow(
			/not found in cldmv\/gh-broker: staus: verified — nothing was changed/
		);
		expect(writes(gh.request)).toEqual([]);
	});

	it("refuses an unknown swap target and an unknown set label too", async () => {
		await expect(issueLabels(gh.octokit, { ...base, swap: { prefix: "status: ", to: "status: done" } })).rejects.toThrow(/status: done/);
		await expect(issueLabels(gh.octokit, { ...base, set: ["nope"] })).rejects.toThrow(/nope/);
		expect(writes(gh.request)).toEqual([]);
	});

	it("create_missing creates unknown labels (default color) before applying them", async () => {
		const out = await issueLabels(gh.octokit, { ...base, add: "area: new", create_missing: true });
		expect(out.created).toEqual(["area: new"]);
		expect(out.added).toEqual(["area: new"]);
		const create = gh.request.mock.calls.find((c) => c[0] === "POST /repos/{owner}/{repo}/labels");
		expect(create?.[1]).toMatchObject({ name: "area: new", color: "ededed" });
	});

	it("create_missing honours a color, with or without #", async () => {
		await issueLabels(gh.octokit, { ...base, add: "x", create_missing: true, color: "#ff0000" });
		const create = gh.request.mock.calls.find((c) => c[0] === "POST /repos/{owner}/{repo}/labels");
		expect(create?.[1].color).toBe("ff0000");
	});

	it("works on a PR number the same way (same endpoints)", async () => {
		const out = await issueLabels(gh.octokit, { ...base, issue_number: 120, add: "area: auth" });
		expect(out.issue).toBe("cldmv/gh-broker#120");
		expect(gh.request.mock.calls.every((c) => !("issue_number" in c[1]) || c[1].issue_number === 120)).toBe(true);
	});

	it("a missing issue fails before any label is created", async () => {
		gh = fakeGitHub(REPO, [], { issueExists: false });
		await expect(issueLabels(gh.octokit, { ...base, add: "brand new", create_missing: true })).rejects.toThrow(/Not Found/);
		expect(writes(gh.request)).toEqual([]);
	});

	it("rethrows a non-404 error from a label lookup or a delete", async () => {
		const boom = Object.assign(new Error("Forbidden"), { status: 403 });
		gh.request.mockImplementationOnce(async () => ({ data: [{ name: "type: bug" }] })).mockRejectedValueOnce(boom);
		await expect(issueLabels(gh.octokit, { ...base, add: "area: auth" })).rejects.toThrow(/Forbidden/);

		gh = fakeGitHub(REPO, ["type: bug"]);
		gh.request.mockImplementationOnce(async () => ({ data: [{ name: "type: bug" }] })).mockRejectedValueOnce(boom);
		await expect(issueLabels(gh.octokit, { ...base, remove: "type: bug" })).rejects.toThrow(/Forbidden/);
	});

	describe("input validation", () => {
		it.each([
			[{ ...base }, /nothing to do/],
			[{ ...base, set: ["a"], add: "b" }, /cannot be combined/],
			[{ ...base, set: ["a"], swap: { prefix: "s", to: "t" } }, /cannot be combined/],
			[{ ...base, add: "a", remove: "A" }, /both added and removed: a/],
			[{ ...base, swap: { prefix: "status: ", to: "status: x" }, remove: "status: x" }, /both added and removed/],
			[{ ...base, add: "" }, /"add" must be a label name/],
			[{ ...base, remove: [42] }, /"remove" must be a label name/],
			[{ ...base, swap: { to: "x" } }, /"swap.prefix" is required/],
			[{ ...base, swap: { prefix: "s: ", to: [] } }, /"swap.to" needs at least one label/],
			[{ ...base, issue_number: 0, add: "a" }, /positive integer/],
			[{ ...base, issue_number: "abc", add: "a" }, /positive integer/],
			[{ ...base, repo: "", add: "a" }, /owner and repo are required/]
		])("rejects %j", async (input, msg) => {
			await expect(issueLabels(gh.octokit, input as any)).rejects.toThrow(msg);
			expect(gh.request).not.toHaveBeenCalled();
		});

		it("dedupes repeated names case-insensitively", async () => {
			await issueLabels(gh.octokit, { ...base, add: ["area: auth", "Area: Auth"] });
			const post = gh.request.mock.calls.find((c) => c[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels");
			expect(post?.[1].labels).toEqual(["area: auth"]);
		});
	});

	it("advertises a strict schema", () => {
		expect(ISSUE_LABELS_SCHEMA.required).toEqual(["owner", "repo", "issue_number"]);
		expect(ISSUE_LABELS_SCHEMA.additionalProperties).toBe(false);
		expect(Object.keys(ISSUE_LABELS_SCHEMA.properties)).toEqual(["owner", "repo", "issue_number", "add", "remove", "swap", "set", "create_missing", "color"]);
	});
});
