import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MANIFEST, permissivePolicy, strictPolicy } from "../src/manifest.ts";
import { DEFAULT_GATED, OTP_STATUS } from "../src/otp/policy.ts";
import { DEFAULT_DISABLED } from "../src/availability.ts";

const rule = (name: string, extra: Record<string, unknown> = {}): any => ({ name, mode: "read", ...extra });

describe("the tool manifest", () => {
	it("declares every tool the broker has per-tool knowledge of, as verb or forwarded entries", () => {
		const names = Object.keys(MANIFEST).sort();
		expect(names).toEqual(
			[
				"actions_run_trigger",
				"assign_copilot_to_issue",
				"assign_copilot_to_issue_with_intent",
				"create_pull_request_with_copilot",
				"create_repository",
				"delete_branch",
				"dismiss_alert",
				"fork_repository",
				"ghcr_push",
				"ghcr_push_status",
				"ghcr_tags",
				"issue_labels",
				"issue_write",
				"label_write",
				"list_pull_requests",
				"merge_pull_request",
				"minimize_comment",
				"npm_scaffold",
				"otp_status",
				"pull_request_read",
				"pull_request_review_write",
				"reply_review_thread",
				"report_alert_status",
				"report_ci_status",
				"report_dependents",
				"report_release_changes",
				"report_release_prs",
				"report_security_alerts",
				"report_unlabeled",
				"resolve_review_thread"
			].sort()
		);
	});

	it("sources every otp fact from DEFAULT_GATED (otp_status never gated)", () => {
		for (const [name, decl] of Object.entries(MANIFEST)) {
			const expected = name === OTP_STATUS ? false : DEFAULT_GATED.has(name);
			expect({ name, otp: decl.otp }).toEqual({ name, otp: expected });
		}
	});

	it("gates and disables exactly today's sets: DEFAULT_GATED and DEFAULT_DISABLED are both in the manifest", () => {
		for (const name of DEFAULT_GATED) expect(MANIFEST[name]).toBeDefined();
		for (const name of DEFAULT_DISABLED) expect(MANIFEST[name]).toBeDefined();
	});

	it("carries a schema + description on verb entries and a request shape on forwarded entries", () => {
		for (const [name, decl] of Object.entries(MANIFEST)) {
			if (decl.kind === "verb") {
				expect(decl.inputSchema.type, name).toBe("object");
				expect(typeof decl.description, name).toBe("string");
				expect(decl.description.length, name).toBeGreaterThan(0);
			} else {
				expect(decl.request, name).toEqual({ op: "mcp", target: name });
			}
		}
	});

	it("names the owner mechanism per tool: creationOwner only on the repo-creating tools, none only on otp_status", () => {
		expect(Object.entries(MANIFEST).filter(([, d]) => d.owner === "creationOwner").map(([n]) => n).sort()).toEqual(["create_repository", "fork_repository"]);
		expect(Object.entries(MANIFEST).filter(([, d]) => d.owner === "none").map(([n]) => n)).toEqual(["otp_status"]);
		for (const [name, decl] of Object.entries(MANIFEST)) {
			if (name !== "otp_status" && decl.owner !== "creationOwner") expect(decl.owner, name).toBe("extractOwner");
		}
	});

	it("marks only the two augmented proxies as augmentable, and only the ghcr verbs as host-only default: off", () => {
		expect(Object.entries(MANIFEST).filter(([, d]) => d.kind === "forwarded" && d.augment).map(([n]) => n).sort()).toEqual(["list_pull_requests", "pull_request_read"]);
		expect(Object.entries(MANIFEST).filter(([, d]) => d.kind === "verb" && d.default === "off").map(([n]) => n).sort()).toEqual(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);
	});
});

describe("the permissive policy (the daemon's pick)", () => {
	it("collects a warning exactly when config widens a manifest tool's mode", () => {
		const { warnings } = permissivePolicy([rule("report_unlabeled", { mode: "write", custom: true })]);
		expect(warnings).toEqual([
			'tool "report_unlabeled": config.tools widens its mode to "write", but the manifest declares "read" — the broker serves it as configured'
		]);
	});

	it("collects a warning exactly when config turns off a manifest-gated tool's OTP", () => {
		const { warnings } = permissivePolicy([rule("merge_pull_request", { mode: "write", otp: false })]);
		expect(warnings).toEqual([
			'tool "merge_pull_request": config.tools turns off its OTP gate ("otp": false), but the manifest gates it — the broker serves it ungated'
		]);
	});

	it("collects one warning per offending rule, in config order", () => {
		// No manifest tool is both read and gated (every DEFAULT_GATED tool is a write), so
		// the two warning cases always land on different rules.
		const { warnings } = permissivePolicy([rule("merge_pull_request", { mode: "write", otp: false }), rule("report_unlabeled", { mode: "write", custom: true })]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatch(/turns off its OTP gate/);
		expect(warnings[1]).toMatch(/widens its mode/);
	});

	it("warns about nothing else", () => {
		const rules = [
			rule("report_unlabeled", { mode: "read", custom: true }), // manifest tool, as declared
			rule("minimize_comment", { mode: "write", otp: true }), // adding a gate is fine
			rule("delete_branch", { mode: "read", custom: true }), // narrowing a write to read is fine
			rule("get_me"), // config-only tool
			rule("mystery_upstream_tool", { mode: "write", otp: false }) // config-only, otp off — no manifest fact
		];
		expect(permissivePolicy(rules).warnings).toEqual([]);
	});

	it("keeps every rule in the output — config-only tools and host-only default:off tools alike (config authority)", () => {
		const rules = [rule("get_me"), rule("ghcr_push", { mode: "write", custom: true }), rule("report_unlabeled", { custom: true })];
		const { tools, warnings } = permissivePolicy(rules);
		expect(tools).toEqual(rules);
		expect(warnings).toEqual([]);
	});
});

describe("the strict policy (the library's default)", () => {
	it("never widens: a manifest-read tool configured write runs as read", () => {
		const { tools, warnings } = strictPolicy([rule("report_unlabeled", { mode: "write", custom: true })]);
		expect(warnings).toEqual([]);
		// The effective mode and gate are always explicit on the output.
		expect(tools).toEqual([rule("report_unlabeled", { mode: "read", custom: true, otp: false })]);
	});

	it("keeps a config-narrowed mode: a manifest-write tool configured read stays read", () => {
		const { tools } = strictPolicy([rule("delete_branch", { mode: "read", custom: true })]);
		expect(tools).toEqual([rule("delete_branch", { mode: "read", custom: true, otp: true })]);
	});

	it("adds OTP gating but never removes it", () => {
		const { tools } = strictPolicy([rule("minimize_comment", { mode: "write", otp: true }), rule("merge_pull_request", { mode: "write", otp: false })]);
		expect(tools.map((t) => [t.name, t.otp])).toEqual([
			["minimize_comment", true], // added
			["merge_pull_request", true] // manifest gate stands despite otp: false
		]);
	});

	it("drops tools that are not in the manifest, and the host-only default:off tools", () => {
		const { tools } = strictPolicy([rule("get_me"), rule("ghcr_push", { mode: "write", custom: true }), rule("report_unlabeled", { custom: true })]);
		expect(tools.map((t) => t.name)).toEqual(["report_unlabeled"]);
	});
});

describe("config.example.json against the manifest (the shipped config pin)", () => {
	const raw = JSON.parse(readFileSync("config.example.json", "utf8")) as { tools: Array<Record<string, unknown>> };
	const names = raw.tools.map((t) => t.name as string);

	it("sits within the manifest under the permissive policy: no mode widening, no OTP turn-off, nothing dropped", () => {
		const { tools, warnings } = permissivePolicy(raw.tools as any);
		expect(warnings).toEqual([]);
		expect(tools).toHaveLength(raw.tools.length);
	});

	it("keeps the daemon-side enabled facts out of the policy: the ghcr entries carry no enabled flag and survive permissive (their default: \"off\" is ignored there)", () => {
		for (const entry of raw.tools.filter((t) => String(t.name).startsWith("ghcr_"))) expect(entry.enabled).toBeUndefined();
		const kept = permissivePolicy(raw.tools as any).tools.map((t) => t.name);
		for (const ghcr of ["ghcr_push", "ghcr_push_status", "ghcr_tags"]) expect(kept).toContain(ghcr);
	});

	it("under the strict policy, exactly the config-only and host-only tools vanish — the pinned delta", () => {
		const survivors = strictPolicy(raw.tools as any).tools.map((t) => t.name).sort();
		// Everything the manifest declares, minus the host-only ghcr verbs.
		expect(survivors).toEqual(
			[
				"actions_run_trigger",
				"assign_copilot_to_issue",
				"assign_copilot_to_issue_with_intent",
				"create_pull_request_with_copilot",
				"create_repository",
				"delete_branch",
				"dismiss_alert",
				"fork_repository",
				"issue_labels",
				"issue_write",
				"label_write",
				"list_pull_requests",
				"merge_pull_request",
				"minimize_comment",
				"npm_scaffold",
				"otp_status",
				"pull_request_read",
				"pull_request_review_write",
				"reply_review_thread",
				"report_alert_status",
				"report_ci_status",
				"report_dependents",
				"report_release_changes",
				"report_release_prs",
				"report_security_alerts",
				"report_unlabeled",
				"resolve_review_thread"
			].sort()
		);
		// The 60 tools a strict host would not serve: 57 config-only forwarded tools plus
		// the 3 host-only ghcr verbs. Any manifest or config.example drift shows up here.
		const vanished = names.filter((n) => !survivors.includes(n)).sort();
		expect(vanished).toEqual(
			[
				"actions_get",
				"actions_list",
				"add_issue_comment",
				"check_dependency_vulnerabilities",
				"create_pull_request",
				"get_code_quality_finding",
				"get_code_scanning_alert",
				"get_commit",
				"get_dependabot_alert",
				"get_discussion",
				"get_discussion_comments",
				"get_file_contents",
				"get_global_security_advisory",
				"get_job_logs",
				"get_label",
				"get_latest_release",
				"get_me",
				"get_notification_details",
				"get_release_by_tag",
				"get_repository_tree",
				"get_secret_scanning_alert",
				"get_tag",
				"get_team_members",
				"get_teams",
				"ghcr_push",
				"ghcr_push_status",
				"ghcr_tags",
				"issue_read",
				"list_branches",
				"list_code_scanning_alerts",
				"list_commits",
				"list_dependabot_alerts",
				"list_discussion_categories",
				"list_discussions",
				"list_global_security_advisories",
				"list_issue_fields",
				"list_issue_types",
				"list_issues",
				"list_label",
				"list_notifications",
				"list_org_repository_security_advisories",
				"list_releases",
				"list_repository_collaborators",
				"list_repository_security_advisories",
				"list_secret_scanning_alerts",
				"list_tags",
				"projects_get",
				"projects_list",
				"request_copilot_review",
				"search_code",
				"search_commits",
				"search_issues",
				"search_orgs",
				"search_pull_requests",
				"search_repositories",
				"search_users",
				"semantic_issue_similarity_search",
				"sub_issue_write",
				"update_pull_request",
				"update_pull_request_branch"
			].sort()
		);
	});

	it("under the strict policy, no mode narrows and the only otp change is the gated tools' gate made explicit", () => {
		const strict = strictPolicy(raw.tools as any).tools;
		const narrowed = strict.filter((t) => {
			const orig = raw.tools.find((r) => r.name === t.name)!;
			return orig.mode === "write" && t.mode === "read";
		});
		expect(narrowed.map((t) => t.name)).toEqual([]);
		// The config omits otp everywhere; the manifest's gating defaults become explicit.
		const otpChanged = strict.filter((t) => {
			const orig = raw.tools.find((r) => r.name === t.name)!;
			return (orig.otp ?? false) !== t.otp;
		});
		expect(otpChanged.map((t) => t.name).sort()).toEqual(
			[
				"actions_run_trigger",
				"assign_copilot_to_issue",
				"assign_copilot_to_issue_with_intent",
				"create_pull_request_with_copilot",
				"create_repository",
				"delete_branch",
				"dismiss_alert",
				"fork_repository",
				"label_write",
				"merge_pull_request",
				"pull_request_review_write"
			].sort()
		);
		for (const t of otpChanged) expect(t.otp).toBe(true);
	});
});
