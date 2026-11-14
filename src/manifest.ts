/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/manifest.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T09:43:28-08:00 (1794678208)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The tool manifest (design #175 §2h): every tool the broker has per-tool knowledge of,
 * declared as data. Two kinds of entry:
 *
 *   - verbs — dispatched locally (src/router.ts's dispatchCustom / callGhcr); the
 *     description and input schema live here, imported from the verb files.
 *   - forwarded — proxied to the hosted MCP; the schema and description live upstream,
 *     so the entry declares only the request shape (`op: "mcp"` + target) and the facts
 *     the broker itself knows: the mode the tool's nature implies, whether it is
 *     OTP-gated by default, and how the owner comes out of the args.
 *
 * The manifest is NOT the universe of servable tools. A daemon config may allowlist any
 * upstream tool name; tools missing from the manifest work config-only (that is the
 * documented workflow for adding an upstream tool). The manifest lists exactly the tools
 * where the broker carries knowledge beyond the config line: the local verbs, the tools
 * with a gating default (src/otp/policy.ts's DEFAULT_GATED), the repo-creating tools'
 * owner rule, the augmented proxies and the host-only ghcr verbs.
 *
 * Every field is sourced from what exists today — nothing is invented here:
 *   - `otp` comes from DEFAULT_GATED (src/otp/policy.ts) — `otp_status` is never gated.
 *   - `mode` is the nature the tool's dispatch/gating knowledge implies (the #146 gated
 *     set "can publish, merge, release or undo something" — all writes; the report verbs
 *     and ghcr status/tags are reads).
 *   - `owner` names today's extraction mechanism (src/router.ts's extractOwner /
 *     creationOwner).
 *   - `default: "off"` marks the host-only ghcr verbs: shipped but off until enabled.
 *     The daemon ignores it (src/availability.ts's DEFAULT_DISABLED and config.ghcr
 *     govern what's enabled there); a strict library host treats the tool as
 *     nonexistent.
 *
 * This module is pure data + types: no host-shaped imports (no fs, env, sockets, audit,
 * secrets), so the library surface can carry it.
 */

import type { Mode, ToolRule } from "./types.ts";
import { DEFAULT_GATED, OTP_STATUS } from "./otp/policy.ts";
import { RESOLVE_REVIEW_THREAD_SCHEMA, REPLY_REVIEW_THREAD_SCHEMA } from "./verbs/review_thread.ts";
import { REPORT_UNLABELED_SCHEMA } from "./verbs/report_unlabeled.ts";
import { REPORT_DEPENDENTS_SCHEMA } from "./verbs/report_dependents.ts";
import { REPORT_SECURITY_ALERTS_SCHEMA } from "./verbs/report_security_alerts.ts";
import { REPORT_RELEASE_PRS_SCHEMA } from "./verbs/report_release_prs.ts";
import { REPORT_RELEASE_CHANGES_SCHEMA } from "./verbs/report_release_changes.ts";
import { REPORT_ALERT_STATUS_SCHEMA } from "./verbs/report_alert_status.ts";
import { ISSUE_LABELS_SCHEMA } from "./verbs/issue_labels.ts";
import { REPORT_CI_STATUS_SCHEMA } from "./verbs/report_ci_status.ts";
import { NPM_SCAFFOLD_SCHEMA } from "./verbs/npm_scaffold.ts";
import { MINIMIZE_COMMENT_DESCRIPTION, MINIMIZE_COMMENT_SCHEMA } from "./verbs/minimize_comment.ts";
import { DELETE_BRANCH_DESCRIPTION, DELETE_BRANCH_SCHEMA } from "./verbs/delete_branch.ts";
import { DISMISS_ALERT_DESCRIPTION, DISMISS_ALERT_SCHEMA } from "./verbs/dismiss_alert.ts";
import { OTP_STATUS_DESCRIPTION, OTP_STATUS_SCHEMA } from "./verbs/otp_status.ts";
import { GHCR_PUSH_DESCRIPTION, GHCR_PUSH_SCHEMA, GHCR_PUSH_STATUS_DESCRIPTION, GHCR_PUSH_STATUS_SCHEMA, GHCR_TAGS_DESCRIPTION, GHCR_TAGS_SCHEMA } from "./verbs/ghcr/schemas.ts";

/** The JSON schema a verb advertises for its arguments. */
export interface ToolInputSchema {
	type: "object";
	[key: string]: unknown;
}

/**
 * How a call's owner comes out of its arguments (src/router.ts):
 *   - "extractOwner" — the generic derivation: args.owner, then args.org, then the
 *     `repo:`/`org:`/`user:` qualifier in args.query, then the owner part of
 *     args.repository (router.ts's extractOwner).
 *   - "creationOwner" — the org a new repo lands in: args.organization, required, and
 *     it must be a configured owner (router.ts's creationOwner; create_repository also
 *     requires `private` explicitly).
 *   - "none" — the call needs no owner (otp_status).
 */
export type OwnerExtraction = "extractOwner" | "creationOwner" | "none";

/** A forwarded call's request shape: the schema and description live upstream. */
export interface McpRequest {
	op: "mcp";
	/** The upstream MCP tool the call forwards to. */
	target: string;
}

interface DeclBase {
	/**
	 * The tool's nature: a read never mutates, a write can. Config may narrow a manifest
	 * tool to read; widening it is a policy concern (the permissive policy warns, the
	 * strict policy clamps).
	 */
	mode: Mode;
	/**
	 * Whether the tool is OTP-gated by default — today's DEFAULT_GATED membership
	 * (src/otp/policy.ts). A host may add gating; removing it on a manifest-gated tool
	 * is a policy concern.
	 */
	otp: boolean;
	/** How the owner comes out of the args. */
	owner: OwnerExtraction;
	/**
	 * Host-only: shipped but off until a host explicitly enables it. The ghcr verbs and the
	 * copilot trio carry it — the daemon ignores it (availability's DEFAULT_DISABLED and
	 * config.ghcr govern what's enabled there); the strict library policy treats the tool
	 * as nonexistent unless the rule says enabled: true.
	 */
	default?: "off";
}

/** A locally dispatched verb: its description and input schema live here. */
export interface VerbDecl extends DeclBase {
	kind: "verb";
	description: string;
	inputSchema: ToolInputSchema;
}

/** A call forwarded to the hosted MCP: its schema and description live upstream. */
export interface ForwardedDecl extends DeclBase {
	kind: "forwarded";
	/** What the call becomes on the wire. */
	request: McpRequest;
	/**
	 * The broker layers its own extension params (ciVerbosity/logLines[/maxDetail]) onto
	 * the forwarded call when the config entry says `augment` — the only forwarded tools
	 * it knows how to post-process (src/catalog.ts, src/router.ts's dispatchAugmented).
	 */
	augment?: true;
}

export type ToolDecl = VerbDecl | ForwardedDecl;

/** Whether `name` is gated when config.tools[i].otp says nothing (src/otp/policy.ts). */
function gated(name: string): boolean {
	return name !== OTP_STATUS && DEFAULT_GATED.has(name);
}

/**
 * The manifest, keyed by tool name. Never mutated; entries are plain frozen-shape data
 * (the schema constants are shared with the verb files and must not be mutated either —
 * the catalog copies before it layers the otp argument on).
 */
export const MANIFEST: Readonly<Record<string, ToolDecl>> = {
	// ── Locally dispatched verbs ────────────────────────────────────────────────
	resolve_review_thread: {
		kind: "verb",
		mode: "write",
		otp: gated("resolve_review_thread"),
		owner: "extractOwner",
		description:
			"Resolve (or unresolve) a pull-request review thread — e.g. mark a Copilot review comment resolved once addressed. Takes the thread node id from pull_request_read get_review_comments. Runs on the write PAT (Pull requests: write).",
		inputSchema: RESOLVE_REVIEW_THREAD_SCHEMA
	},
	reply_review_thread: {
		kind: "verb",
		mode: "write",
		otp: gated("reply_review_thread"),
		owner: "extractOwner",
		description:
			"Post a reply inside a pull-request review thread — e.g. respond to a Copilot review comment. Takes the thread node id from pull_request_read get_review_comments. Runs on the write PAT (Pull requests: write).",
		inputSchema: REPLY_REVIEW_THREAD_SCHEMA
	},
	issue_labels: {
		kind: "verb",
		mode: "write",
		otp: gated("issue_labels"),
		owner: "extractOwner",
		description:
			'Edit the labels on one issue or PR without touching any other label on it. add / remove take one label or several (combinable in one call); swap { prefix, to } removes every label starting with prefix and adds to (e.g. prefix "status: ", to "status: verified"); set replaces the whole set and only as an explicit choice. Labels already present (add) or absent (remove) are no-ops. A label name to add that does not exist in the repo refuses the call and changes nothing, unless create_missing is true. Returns the resulting label set plus what was added, removed and created. Runs on the write PAT (Issues: write).',
		inputSchema: ISSUE_LABELS_SCHEMA
	},
	npm_scaffold: {
		kind: "verb",
		mode: "write",
		otp: gated("npm_scaffold"),
		owner: "extractOwner",
		description:
			"Create a new npm package and register its GitHub Actions trusted publisher, so the repo's publish workflow can release it through OIDC from then on. Publishes a broker-built placeholder (0.0.1-placeholder, no code) and never publishes a version of an existing package. Every npm write needs its own one-time password from the user, passed as npm_otp, so it takes two calls: the first publishes the placeholder and returns status needs_otp; ask the user for the next npm code and call again with it in npm_otp to add the trusted publisher. Ask for each code right before the call. A refused or expired code also returns needs_otp with the remaining steps. Checks first that the repo's package.json names the package and that the workflow file exists. Uses the broker's npm token (no 2FA bypass) and the read PAT.",
		inputSchema: NPM_SCAFFOLD_SCHEMA
	},
	report_unlabeled: {
		kind: "verb",
		mode: "read",
		otp: gated("report_unlabeled"),
		owner: "extractOwner",
		description:
			"Report issues and/or PRs with no labels, for one repo or every non-archived repo an owner has. Bounded by maxRepos/perRepoLimit/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit mid-scan. Runs on the read PAT.",
		inputSchema: REPORT_UNLABELED_SCHEMA
	},
	report_security_alerts: {
		kind: "verb",
		mode: "read",
		otp: gated("report_security_alerts"),
		owner: "extractOwner",
		description:
			"Report every open Dependabot, code-scanning (CodeQL) and secret-scanning alert, for one repo or across every repo an owner has. Reads the org-level endpoints in a handful of calls and falls back to a per-repo sweep for any alert type the token can't read org-wide. Alert state tracks the default branch. Secret values are never returned. Bounded by maxRepos/alertLimit/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
		inputSchema: REPORT_SECURITY_ALERTS_SCHEMA
	},
	report_alert_status: {
		kind: "verb",
		mode: "read",
		otp: gated("report_alert_status"),
		owner: "extractOwner",
		description:
			"For every open Dependabot alert in one repo, a list of repos, or every repo an owner has, say where its fix stands. Each alert gets one bucket: released-still-open (the default branch's lockfile is already patched, yet the alert is open), fixed-on-next (next or hotfixes is patched, the default branch isn't; waiting for a release), open-pr (an open PR bumps the package; notes a hotfix-redirect twin), closed-unmerged (only closed PRs, and whether a later merge superseded them), or no-pr. Reads package-lock.json / pnpm-lock.yaml / yarn.lock nearest the alert's manifest at each branch, once per commit, size-capped. Also hints per repo whether Dependabot looks paused. Bounded by maxApiCalls; returns truncated:true with a reason and the unreached repos in pending if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
		inputSchema: REPORT_ALERT_STATUS_SCHEMA
	},
	report_dependents: {
		kind: "verb",
		mode: "read",
		otp: gated("report_dependents"),
		owner: "extractOwner",
		description:
			"Find every non-archived, non-fork repo an owner has that declares an npm package in dependencies, devDependencies or peerDependencies, with the declared range, the version the lockfile resolved (package-lock.json or pnpm-lock.yaml), the repo's flow tier (v4 / dev-trunk / non-v4), default branch and visibility. Workspace members are reported against their repo with the member path. Optional latest:true marks the resolved versions that are behind the latest published one. Candidates come from one org code search and are each verified against the default-branch package.json; the search lags recent commits and misses dev-trunk repos whose manifests live on dev (see discovery.note). Bounded by maxRepos/maxFileBytes/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
		inputSchema: REPORT_DEPENDENTS_SCHEMA
	},
	report_release_prs: {
		kind: "verb",
		mode: "read",
		otp: gated("report_release_prs"),
		owner: "extractOwner",
		description:
			"Report every open release PR (label `release`: next→master and hotfixes→master) for one repo or across every repo an owner has, and whether each one's per-version changelog file (docs/changelog[s]/v<major>/vX.Y.Z.md) is already on the release branch. Status per PR: ready, needs-changelog, or unknown-version (title has no `release: vX.Y.Z`). Use during mass updates to find which repos need a changelog. One search call plus two calls per release PR found; returns truncated:true with a reason if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
		inputSchema: REPORT_RELEASE_PRS_SCHEMA
	},
	report_release_changes: {
		kind: "verb",
		mode: "read",
		otp: gated("report_release_changes"),
		owner: "extractOwner",
		description:
			"Source material for one release's changelog. For a release PR (owner, repo, pull) it returns the version, head/base, the previous release, every PR that actually ships (from the release PR's commits, first line only; docs PRs, the version bump, PRs an earlier release or the previous changelog already carried, and PRs reverted inside the range are left out and listed under excluded), each with title, type, labels, author, merge date, closed issues and, by `detail`, its body, file list or patches (capped, with truncation flags). PRs are grouped by changelog section (breaking, features, fixes, security, CI & tooling, documentation, dependencies, or ungrouped when unclear), with breaking-change hints, `documented` when the version's changelog already mentions a PR, interim hotfix releases not on the head branch, a net block (package.json deltas, direct-dependency changes with locked versions, file totals) and an optional markdown skeleton. Returns truncated:true with a reason if the call budget or GitHub's rate limit is hit. Runs on the read PAT.",
		inputSchema: REPORT_RELEASE_CHANGES_SCHEMA
	},
	report_ci_status: {
		kind: "verb",
		mode: "read",
		otp: gated("report_ci_status"),
		owner: "extractOwner",
		description:
			"Report CI health for a PR, or every open PR in a repo, at a chosen verbosity: 0 counts only, 1 adds which run/job failed, 2 adds which step failed, 3 adds a tail of the failing job's log. Detail beyond tier 0 is only fetched for runs that are actually failing. Runs on the read PAT.",
		inputSchema: REPORT_CI_STATUS_SCHEMA
	},
	minimize_comment: {
		kind: "verb",
		mode: "write",
		otp: gated("minimize_comment"),
		owner: "extractOwner",
		description: MINIMIZE_COMMENT_DESCRIPTION,
		inputSchema: MINIMIZE_COMMENT_SCHEMA
	},
	delete_branch: {
		kind: "verb",
		mode: "write",
		otp: gated("delete_branch"),
		owner: "extractOwner",
		description: DELETE_BRANCH_DESCRIPTION,
		inputSchema: DELETE_BRANCH_SCHEMA
	},
	dismiss_alert: {
		kind: "verb",
		mode: "write",
		otp: gated("dismiss_alert"),
		owner: "extractOwner",
		description: DISMISS_ALERT_DESCRIPTION,
		inputSchema: DISMISS_ALERT_SCHEMA
	},
	// otp_status is never gated (src/otp/policy.ts) and needs no owner or PAT.
	otp_status: {
		kind: "verb",
		mode: "read",
		otp: gated(OTP_STATUS),
		owner: "none",
		description: OTP_STATUS_DESCRIPTION,
		inputSchema: OTP_STATUS_SCHEMA
	},
	// Host-only ghcr verbs: shipped but off until enabled (`default: "off"`). The daemon
	// ignores that field — availability's DEFAULT_DISABLED/config.ghcr govern there; the
	// strict library policy treats them as nonexistent.
	ghcr_push: {
		kind: "verb",
		mode: "write",
		otp: gated("ghcr_push"),
		owner: "extractOwner",
		default: "off",
		description: GHCR_PUSH_DESCRIPTION,
		inputSchema: GHCR_PUSH_SCHEMA
	},
	ghcr_push_status: {
		kind: "verb",
		mode: "read",
		otp: gated("ghcr_push_status"),
		owner: "extractOwner",
		default: "off",
		description: GHCR_PUSH_STATUS_DESCRIPTION,
		inputSchema: GHCR_PUSH_STATUS_SCHEMA
	},
	ghcr_tags: {
		kind: "verb",
		mode: "read",
		otp: gated("ghcr_tags"),
		owner: "extractOwner",
		default: "off",
		description: GHCR_TAGS_DESCRIPTION,
		inputSchema: GHCR_TAGS_SCHEMA
	},
	// ── Forwarded to the hosted MCP (schema + description live upstream) ───────
	pull_request_read: {
		kind: "forwarded",
		mode: "read",
		otp: gated("pull_request_read"),
		owner: "extractOwner",
		request: { op: "mcp", target: "pull_request_read" },
		augment: true
	},
	list_pull_requests: {
		kind: "forwarded",
		mode: "read",
		otp: gated("list_pull_requests"),
		owner: "extractOwner",
		request: { op: "mcp", target: "list_pull_requests" },
		augment: true
	},
	issue_write: {
		kind: "forwarded",
		mode: "write",
		otp: gated("issue_write"),
		owner: "extractOwner",
		request: { op: "mcp", target: "issue_write" }
	},
	// The repo-creating tools pick their PAT by the org the repo lands in — that is
	// creationOwner, not extractOwner (src/router.ts).
	create_repository: {
		kind: "forwarded",
		mode: "write",
		otp: gated("create_repository"),
		owner: "creationOwner",
		request: { op: "mcp", target: "create_repository" }
	},
	fork_repository: {
		kind: "forwarded",
		mode: "write",
		otp: gated("fork_repository"),
		owner: "creationOwner",
		request: { op: "mcp", target: "fork_repository" }
	},
	merge_pull_request: {
		kind: "forwarded",
		mode: "write",
		otp: gated("merge_pull_request"),
		owner: "extractOwner",
		request: { op: "mcp", target: "merge_pull_request" }
	},
	pull_request_review_write: {
		kind: "forwarded",
		mode: "write",
		otp: gated("pull_request_review_write"),
		owner: "extractOwner",
		request: { op: "mcp", target: "pull_request_review_write" }
	},
	actions_run_trigger: {
		kind: "forwarded",
		mode: "write",
		otp: gated("actions_run_trigger"),
		owner: "extractOwner",
		request: { op: "mcp", target: "actions_run_trigger" }
	},
	label_write: {
		kind: "forwarded",
		mode: "write",
		otp: gated("label_write"),
		owner: "extractOwner",
		request: { op: "mcp", target: "label_write" }
	},
	// Disabled by default everywhere: the daemon keeps them off via availability's
	// DEFAULT_DISABLED, and strict hosts drop them until a rule says `enabled: true`
	// explicitly — strict must never be looser than the daemon. Gated once enabled.
	create_pull_request_with_copilot: {
		kind: "forwarded",
		mode: "write",
		otp: gated("create_pull_request_with_copilot"),
		owner: "extractOwner",
		request: { op: "mcp", target: "create_pull_request_with_copilot" },
		default: "off"
	},
	assign_copilot_to_issue: {
		kind: "forwarded",
		mode: "write",
		otp: gated("assign_copilot_to_issue"),
		owner: "extractOwner",
		request: { op: "mcp", target: "assign_copilot_to_issue" },
		default: "off"
	},
	assign_copilot_to_issue_with_intent: {
		kind: "forwarded",
		mode: "write",
		otp: gated("assign_copilot_to_issue_with_intent"),
		owner: "extractOwner",
		request: { op: "mcp", target: "assign_copilot_to_issue_with_intent" },
		default: "off"
	}
};

/**
 * The two policies (design #175 §2h) a host picks between explicitly. Both take the
 * config's tool rules and return the rules a host serving under that policy would run,
 * with the effective mode and OTP gate — the shape the catalog build consumes. Config
 * facts the policies don't touch (custom, augment, enabled) pass through unchanged.
 */
export interface PolicyApplication {
	tools: ToolRule[];
	/**
	 * Startup warnings for config facts that exceed the manifest. The permissive policy
	 * collects them and serves as configured; the strict policy never has any — it
	 * enforces instead.
	 */
	warnings: string[];
}

/**
 * The daemon's policy: config.json keeps today's authority. Tools missing from the
 * manifest work config-only; a config that widens a manifest tool's mode or turns off
 * its OTP gate is served as configured — never refused — but each such fact collects a
 * startup warning here. The manifest's `default: "off"` is ignored (on the daemon,
 * availability's DEFAULT_DISABLED and config.ghcr govern what's enabled).
 */
export function permissivePolicy(rules: readonly ToolRule[]): PolicyApplication {
	const tools = [...rules];
	const warnings: string[] = [];
	for (const rule of rules) {
		// Object.hasOwn: inherited keys must not give a config-only tool manifest facts.
		const decl = Object.hasOwn(MANIFEST, rule.name) ? MANIFEST[rule.name] : undefined;
		if (!decl) continue; // config-only tool: no manifest facts to exceed
		if (decl.mode === "read" && rule.mode === "write") {
			warnings.push(`tool "${rule.name}": config.tools widens its mode to "write", but the manifest declares "read" — the broker serves it as configured`);
		}
		if (decl.otp && rule.otp === false) {
			warnings.push(`tool "${rule.name}": config.tools turns off its OTP gate ("otp": false), but the manifest gates it — the broker serves it ungated`);
		}
	}
	return { tools, warnings };
}

/**
 * The library's default policy (Quack and other hosts): the manifest is the universe.
 * Tools missing from it don't exist, and host-only `default: "off"` tools are
 * nonexistent until a host explicitly enables them. A surviving tool runs at
 * min(manifest mode, config mode) — the policy never widens a mode — and its OTP gate
 * can only be added, never removed.
 */
export function strictPolicy(rules: readonly ToolRule[]): PolicyApplication {
	const tools: ToolRule[] = [];
	for (const rule of rules) {
		// Object.hasOwn: inherited keys ("constructor", "toString", "__proto__") must not make
		// an unknown tool exist.
		if (!Object.hasOwn(MANIFEST, rule.name)) continue; // not in the manifest → doesn't exist
		const decl = MANIFEST[rule.name]!;
		// Host-only and default-off tools don't exist until the rule enables them explicitly —
		// strict is never looser than the daemon, which keeps these off via availability.
		if (decl.default === "off" && rule.enabled !== true) continue;
		tools.push({
			...rule,
			// min(manifest, config): read beats write.
			mode: decl.mode === "read" ? "read" : rule.mode,
			// Add-only: the manifest's gate stands even if config says otherwise. otp_status is
			// never gated (src/otp/policy.ts), so a config otp on it is ignored.
			otp: rule.name === OTP_STATUS ? undefined : decl.otp || rule.otp === true,
			// A tool is custom exactly when the manifest serves it as a verb, and augmentable
			// exactly where the manifest declares it — config can't add either.
			custom: decl.kind === "verb",
			...("augment" in decl && decl.augment ? { augment: true as const } : {})
		});
	}
	return { tools, warnings: [] };
}
