import { describe, it, expect, vi, beforeEach } from "vitest";
import { issueLabels, ISSUE_LABELS_SCHEMA } from "../src/verbs/issue_labels.ts";

/**
 * A tiny in-memory GitHub: repo labels + one issue's labels, answering the REST routes
 * issue_labels uses the way GitHub does (case-insensitive names, 404 for an unknown
 * label or a label not on the issue, POST appends, PUT replaces, DELETE returns the rest).
 */
type FakeOpts = {
	issueExists?: boolean;
	/** Model a DELETE that matches the label name case-sensitively (the worst case). */
	caseSensitiveDelete?: boolean;
	/** Return an error to make that request fail instead of applying it. */
	fail?: (route: string, params: any) => Error | undefined;
};

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

function fakeGitHub(repoLabels: string[], issueLabels: string[], opts: FakeOpts = {}) {
	const repo = [...repoLabels];
	let issue = [...issueLabels];
	const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
	const find = (list: string[], n: string) => list.find((l) => l.toLowerCase() === String(n).toLowerCase());
	const asData = () => issue.map((name) => ({ name }));
	const request = vi.fn(async (route: string, p: any) => {
		if (route.includes("/issues/") && opts.issueExists === false) throw notFound();
		const injected = opts.fail?.(route, p);
		if (injected) throw injected;
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
				const hit = opts.caseSensitiveDelete ? issue.find((l) => l === p.name) : find(issue, p.name);
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

	describe("partial failures (finding 1)", () => {
		it("a failing add leaves the swap's removals unapplied, so the issue keeps its status label", async () => {
			gh = fakeGitHub(REPO, ["priority: high", "status: in progress"], {
				fail: (route) => (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels" ? httpError(403, "API rate limit exceeded") : undefined)
			});
			const err = await issueLabels(gh.octokit, { ...base, swap: { prefix: "status: ", to: "status: verified" } }).catch((e) => e);
			expect(gh.issue).toEqual(["priority: high", "status: in progress"]);
			expect(err.message).toBe(
				"issue_labels: failed part-way on cldmv/gh-broker#117: API rate limit exceeded. Applied: nothing. Not applied: added [status: verified]; removed [status: in progress]."
			);
			expect(err.status).toBe(403);
			expect(err.cause.message).toBe("API rate limit exceeded");
		});

		it("adds before it removes", async () => {
			gh = fakeGitHub(REPO, ["status: in progress"]);
			await issueLabels(gh.octokit, { ...base, swap: { prefix: "status: ", to: "status: verified" } });
			expect(writes(gh.request)).toEqual([
				"POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
				"DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}"
			]);
		});

		it("a removal failing mid-list reports which removals went through", async () => {
			gh = fakeGitHub(REPO, ["type: bug", "priority: high", "area: auth"], {
				fail: (route, p) => (route.startsWith("DELETE") && p.name === "priority: high" ? httpError(502, "Bad Gateway") : undefined)
			});
			const err = await issueLabels(gh.octokit, { ...base, add: "status: verified", remove: ["type: bug", "priority: high", "area: auth"] }).catch((e) => e);
			expect(err.message).toBe(
				"issue_labels: failed part-way on cldmv/gh-broker#117: Bad Gateway. Applied: added [status: verified]; removed [type: bug]. Not applied: removed [priority: high, area: auth]."
			);
			expect(gh.issue).toEqual(["priority: high", "area: auth", "status: verified"]);
		});

		it("a create failing part-way reports the label already created and everything still pending", async () => {
			gh = fakeGitHub(REPO, ["status: in progress"], {
				fail: (route, p) => (route === "POST /repos/{owner}/{repo}/labels" && p.name === "area: two" ? httpError(422, "Validation Failed") : undefined)
			});
			const err = await issueLabels(gh.octokit, { ...base, add: ["area: one", "area: two"], remove: "status: in progress", create_missing: true }).catch((e) => e);
			expect(err.message).toBe(
				"issue_labels: failed part-way on cldmv/gh-broker#117: Validation Failed. Applied: created [area: one]. Not applied: created [area: two]; added [area: one, area: two]; removed [status: in progress]."
			);
			expect(gh.repo).toContain("area: one");
			expect(gh.issue).toEqual(["status: in progress"]);
		});

		it("a failing set reports the created labels and the set that was not applied", async () => {
			gh = fakeGitHub(REPO, ["type: bug"], {
				fail: (route) => (route.startsWith("PUT") ? httpError(500, "Server Error") : undefined)
			});
			const err = await issueLabels(gh.octokit, { ...base, set: ["type: bug", "area: new"], create_missing: true }).catch((e) => e);
			expect(err.message).toBe(
				"issue_labels: failed part-way on cldmv/gh-broker#117: Server Error. Applied: created [area: new]. Not applied: set [type: bug, area: new]."
			);
			expect(gh.issue).toEqual(["type: bug"]);
		});

		it("reports a set as applied when only building the result fails", async () => {
			// The PUT succeeds but answers with a label that has no name, which the result builder cannot lowercase.
			const g = fakeGitHub(REPO, ["type: bug"]);
			const inner = g.request.getMockImplementation()!;
			g.request.mockImplementation(async (route: string, p: any) => (route.startsWith("PUT") ? { data: [{}] } : inner(route, p)));
			const err = await issueLabels(g.octokit, { ...base, set: ["type: bug"] }).catch((e) => e);
			expect(err.message).toMatch(/failed part-way on cldmv\/gh-broker#117: .*Applied: set \[type: bug\]\. Not applied: nothing\.$/);
		});

		it("treats label lists that are not arrays as empty", async () => {
			const request = vi.fn(async (route: string) => (route.startsWith("POST /repos/{owner}/{repo}/issues") ? { data: null } : route.startsWith("GET /repos/{owner}/{repo}/issues") ? { data: {} } : { data: { name: "x" } }));
			const out = await issueLabels({ request } as any, { ...base, add: "x" });
			expect(out.labels).toEqual([]);
		});

		it("a failing first read or label lookup writes nothing and is passed through unchanged", async () => {
			gh = fakeGitHub(REPO, ["type: bug"], { fail: (route) => (route === "GET /repos/{owner}/{repo}/labels/{name}" ? httpError(500, "Server Error") : undefined) });
			await expect(issueLabels(gh.octokit, { ...base, add: "area: auth" })).rejects.toThrow(/^Server Error$/);
			expect(writes(gh.request)).toEqual([]);
		});
	});

	it("skips the DELETE for labels the issue doesn't have (finding 2)", async () => {
		const out = await issueLabels(gh.octokit, { ...base, remove: ["area: auth", "nope", "type: bug"] });
		expect(gh.request.mock.calls.filter((c) => String(c[0]).startsWith("DELETE")).map((c) => c[1].name)).toEqual(["type: bug"]);
		expect(out.removed).toEqual(["type: bug"]);
	});

	it("accepts exactly 100 labels on a side", async () => {
		const many = Array.from({ length: 100 }, (_, i) => `x${i}`);
		const out = await issueLabels(gh.octokit, { ...base, remove: many });
		expect(out.removed).toEqual([]);
		expect(writes(gh.request)).toEqual([]);
	});

	it("does not delete and re-add an add-side label that matches the swap prefix (finding 5)", async () => {
		gh = fakeGitHub(REPO, ["status: in progress", "status: not started"]);
		const out = await issueLabels(gh.octokit, { ...base, add: "status: in progress", swap: { prefix: "status: ", to: "status: verified" } });
		expect(gh.request.mock.calls.filter((c) => String(c[0]).startsWith("DELETE")).map((c) => c[1].name)).toEqual(["status: not started"]);
		expect(out.labels).toEqual(["status: in progress", "status: verified"]);
		expect(out.removed).toEqual(["status: not started"]);
	});

	it("removes using the spelling already on the issue (finding 6)", async () => {
		gh = fakeGitHub([...REPO, "Bug"], ["Bug", "status: in progress"], { caseSensitiveDelete: true });
		const out = await issueLabels(gh.octokit, { ...base, remove: "bug" });
		expect(gh.request.mock.calls.find((c) => String(c[0]).startsWith("DELETE"))?.[1].name).toBe("Bug");
		expect(out.labels).toEqual(["status: in progress"]);
		expect(out.removed).toEqual(["Bug"]);
	});

	it("treats a label removed by someone else since the read as already removed", async () => {
		gh = fakeGitHub(REPO, ["type: bug"], { fail: (route) => (route.startsWith("DELETE") ? httpError(404, "Label does not exist") : undefined) });
		const out = await issueLabels(gh.octokit, { ...base, remove: "type: bug" });
		expect(out.removed).toEqual([]);
	});

	it("accepts an uppercase color with #", async () => {
		await issueLabels(gh.octokit, { ...base, add: "x", create_missing: true, color: "#ABCDEF" });
		expect(gh.request.mock.calls.find((c) => c[0] === "POST /repos/{owner}/{repo}/labels")?.[1].color).toBe("ABCDEF");
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
			[{ ...base, swap: { prefix: "s: ", to: [] } }, /"swap.to" is empty/],
			[{ ...base, swap: { prefix: "s: " } }, /"swap.to" needs at least one label/],
			[{ ...base, issue_number: 0, add: "a" }, /positive integer/],
			[{ ...base, issue_number: "abc", add: "a" }, /positive integer/],
			[{ ...base, repo: "", add: "a" }, /"repo" must be a non-empty string/],
			// Finding 3: an empty set would wipe every label.
			[{ ...base, set: [] }, /"set" is empty/],
			[{ ...base, add: [] }, /"add" is empty/],
			// Finding 4: the handler enforces the schema — unknown keys and wrong types are refused.
			[{ ...base, add: "type: bug", remvoe: "priority: high" }, /unknown argument\(s\): remvoe/],
			[{ ...base, swap: { prefix: "status: ", to: "status: verified", too: "x" } }, /unknown "swap" key\(s\): too/],
			[{ ...base, swap: "status: " }, /"swap" must be an object/],
			[{ ...base, issue_number: true, add: "a" }, /"issue_number" must be a positive integer/],
			[{ ...base, issue_number: 1.5, add: "a" }, /"issue_number" must be a positive integer/],
			[{ ...base, owner: 5, add: "a" }, /"owner" must be a non-empty string/],
			[{ ...base, repo: ["gh-broker"], add: "a" }, /"repo" must be a non-empty string/],
			[{ ...base, add: "a", create_missing: "yes" }, /"create_missing" must be a boolean/],
			// Finding 7: color must be a 6-digit hex value.
			[{ ...base, add: "a", create_missing: true, color: "red" }, /"color" must be a 6-digit hex color/],
			[{ ...base, add: "a", create_missing: true, color: "#12345" }, /"color" must be a 6-digit hex color/],
			[null, /arguments must be an object/],
			// Finding 2: list sizes are capped.
			[{ ...base, remove: Array.from({ length: 101 }, (_, i) => `l${i}`) }, /"remove" has 101 labels — at most 100/],
			[{ ...base, add: Array.from({ length: 101 }, (_, i) => `l${i}`) }, /"add" has 101 labels — at most 100/],
			[{ ...base, add: Array.from({ length: 60 }, (_, i) => `a${i}`), swap: { prefix: "s: ", to: Array.from({ length: 41 }, (_, i) => `s: ${i}`) } }, /101 labels to add — at most 100/]
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
