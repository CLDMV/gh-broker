/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/router.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:12:11-07:00 (1793473931)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SecretStore, ToolRule } from "./types.ts";
import type { AppAuth } from "./appauth.ts";
import { Octokit } from "@octokit/core";
import { indexTools } from "./config.ts";
import { audit } from "./audit.ts";
import { unavailableReason } from "./availability.ts";
// DEFERRED: link_issue is App-token-only and not wired in — see docs.
// import { linkIssue, type LinkIssueInput } from "./verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	type ResolveReviewThreadInput,
	type ReplyReviewThreadInput
} from "./verbs/review_thread.ts";
import { reportUnlabeled, type ReportUnlabeledInput } from "./verbs/report_unlabeled.ts";
import { reportSecurityAlerts, type ReportSecurityAlertsInput } from "./verbs/report_security_alerts.ts";
import { reportReleasePrs, type ReportReleasePrsInput } from "./verbs/report_release_prs.ts";
import { issueLabels, type IssueLabelsInput } from "./verbs/issue_labels.ts";
import { reportCiStatus, ciStatusForHeadSha, type ReportCiStatusInput, type FailedJobLogsFetcher } from "./verbs/report_ci_status.ts";
import { npmScaffold } from "./verbs/npm_scaffold.ts";
import { NpmRegistry } from "./verbs/npm-registry.ts";
import { GhcrService } from "./verbs/ghcr_push.ts";

const GHCR_TOOLS = new Set(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);

/** What the router needs from the upstream (hosted-MCP) client pool. */
export interface Upstream {
	forward(tool: string, args: Record<string, unknown>, token: string): Promise<CallToolResult>;
}

/**
 * Enforces the default-deny allowlist, resolves the (owner, mode) → PAT, and either
 * forwards to the hosted MCP or dispatches a custom verb. The token never leaves here.
 */
export class Router {
	private readonly config: Config;
	private readonly secrets: SecretStore;
	private readonly upstream: Upstream;
	private readonly appAuth?: AppAuth;
	private readonly rules: Map<string, ToolRule>;
	/** GHCR verbs run on config.ghcr's own credential, not the owner's GitHub PAT (created on first use). */
	private ghcr?: GhcrService;

	constructor(config: Config, secrets: SecretStore, upstream: Upstream, appAuth?: AppAuth) {
		this.config = config;
		this.secrets = secrets;
		this.upstream = upstream;
		this.appAuth = appAuth;
		this.rules = indexTools(config.tools);
	}

	/** Tools advertised to the agent (used to build tools/list). */
	advertisedTools(): ToolRule[] {
		return this.config.tools.filter((rule) => !unavailableReason(rule, this.config, this.secrets));
	}

	async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const rule = this.rules.get(tool);
		if (!rule) {
			audit({ tool, decision: "deny", detail: "not in allowlist" });
			throw new Error(`tool "${tool}" is not allowed`);
		}
		// An optional integration that isn't set up hides its tools: refuse them the same way.
		const unavailable = unavailableReason(rule, this.config, this.secrets);
		if (unavailable) {
			audit({ tool, decision: "deny", detail: `unavailable: ${unavailable}` });
			throw new Error(`tool "${tool}" is not available on this broker: ${unavailable}`);
		}
		// The GHCR verbs authenticate with config.ghcr's own credential, never an owner's GitHub
		// PAT, so they don't need (or touch) a config.owners entry.
		if (GHCR_TOOLS.has(tool)) return this.callGhcr(tool, args, rule);
		// Owner-less reads (global advisory DB, get_me, notifications) fall back to
		// the configured defaultOwner's READ PAT. Writes never fall back — a write
		// must always name the owner it targets.
		let owner = extractOwner(args);
		if (!owner && rule.mode === "read" && this.config.defaultOwner && this.config.owners[this.config.defaultOwner]) {
			owner = this.config.defaultOwner.toLowerCase();
		}
		if (!owner) {
			audit({ tool, decision: "error", detail: "no owner in args" });
			throw new Error(`tool "${tool}": could not determine repo owner from arguments`);
		}
		const creds = this.config.owners[owner];
		if (!creds) {
			audit({ tool, owner, decision: "error", detail: "no creds for owner" });
			throw new Error(`no credentials configured for owner "${owner}" — add it to config.owners + creds`);
		}
		const token = this.secrets.resolve(rule.mode === "write" ? creds.write : creds.read);
		const repo = typeof args.repo === "string" ? `${owner}/${args.repo}` : owner;

		const decision = rule.custom ? "custom" : rule.augment ? "augment" : "forward";
		try {
			const out = rule.custom
				? await this.dispatchCustom(tool, args, owner, token)
				: rule.augment
					? await this.dispatchAugmented(tool, args, owner, token)
					: await this.upstream.forward(tool, args, token);
			audit({ tool, owner, mode: rule.mode, repo, decision, ok: true });
			return out;
		} catch (err) {
			audit({ tool, owner, mode: rule.mode, repo, decision, ok: false, detail: (err as Error).message });
			throw err;
		}
	}

	/** GHCR verbs: config.ghcr checks the owner and image itself; no GitHub PAT is resolved. */
	private async callGhcr(tool: string, args: Record<string, unknown>, rule: ToolRule): Promise<CallToolResult> {
		const owner = extractOwner(args) ?? "";
		const repo = typeof args.image === "string" ? `${owner}/${args.image}` : owner;
		try {
			this.ghcr ??= new GhcrService(this.config.ghcr, this.secrets);
			const out = tool === "ghcr_push" ? await this.ghcr.push(args) : tool === "ghcr_tags" ? await this.ghcr.tags(args) : this.ghcr.status(args);
			audit({ tool, owner, mode: rule.mode, repo, decision: "custom", ok: true });
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		} catch (err) {
			audit({ tool, owner, mode: rule.mode, repo, decision: "custom", ok: false, detail: (err as Error).message });
			throw err;
		}
	}

	private async dispatchCustom(
		tool: string,
		args: Record<string, unknown>,
		owner: string,
		token: string
	): Promise<CallToolResult> {
		switch (tool) {
			// DEFERRED: link_issue (App-token-only addClosingIssueReference) is not wired in — see docs.
			// Re-enable by restoring this case + the import above + the catalog block, adding a
			// link_issue allowlist entry to config, and configuring config.app + owner installationId.
			// case "link_issue": {
			// 	const octokit = this.appAuth?.octokitFor(owner);
			// 	if (!octokit) {
			// 		throw new Error(`link_issue needs a GitHub App for "${owner}": set config.app + owners.${owner}.installationId + the app key cred (addClosingIssueReference is App-token-only — not available to fine-grained PATs)`);
			// 	}
			// 	const out = await linkIssue(octokit, args as unknown as LinkIssueInput);
			// 	return { content: [{ type: "text", text: `linked: PR ${out.pullRequestId} → issue ${out.issueId}` }] };
			// }
			case "resolve_review_thread": {
				// PAT-usable (Pull requests: write) — run on the resolved write PAT, not the App token.
				const octokit = new Octokit({ auth: token });
				const out = await resolveReviewThread(octokit, args as unknown as ResolveReviewThreadInput);
				return { content: [{ type: "text", text: `thread ${out.threadId}: isResolved=${out.isResolved}` }] };
			}
			case "reply_review_thread": {
				const octokit = new Octokit({ auth: token });
				const out = await replyReviewThread(octokit, args as unknown as ReplyReviewThreadInput);
				return { content: [{ type: "text", text: `replied: ${out.url}` }] };
			}
			case "issue_labels": {
				// Per-label REST endpoints (Issues: write) on the resolved write PAT.
				const octokit = new Octokit({ auth: token });
				const out = await issueLabels(octokit, args as unknown as IssueLabelsInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "report_unlabeled": {
				const octokit = new Octokit({ auth: token });
				const out = await reportUnlabeled(octokit, args as unknown as ReportUnlabeledInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "report_security_alerts": {
				const octokit = new Octokit({ auth: token });
				const out = await reportSecurityAlerts(octokit, args as unknown as ReportSecurityAlertsInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "report_release_prs": {
				const octokit = new Octokit({ auth: token });
				const out = await reportReleasePrs(octokit, args as unknown as ReportReleasePrsInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "report_ci_status": {
				const octokit = new Octokit({ auth: token });
				const reportArgs = args as unknown as ReportCiStatusInput;
				const out = await reportCiStatus(octokit, reportArgs, this.makeJobLogsFetcher(owner, reportArgs.repo, token));
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "npm_scaffold": {
				const npm = this.config.npm!; // availability already required it
				// The GitHub side only reads (repo metadata, package.json, workflow file), so it
				// runs on the read PAT even though the verb is a write.
				const octokit = new Octokit({ auth: this.secrets.resolve(this.config.owners[owner]!.read) });
				const registry = new NpmRegistry({ token: this.secrets.resolve(npm.token), ...(npm.registry ? { registry: npm.registry } : {}) });
				const out = await npmScaffold(args, { octokit, registry, scopes: npm.scopes });
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			default:
				throw new Error(`custom verb "${tool}" not implemented`);
		}
	}

	/**
	 * A failing-run's job logs, via the hosted MCP's own `get_job_logs` tool
	 * (`failed_only: true` fetches every failing job in the run in one call) rather
	 * than a hand-rolled REST call — see report_ci_status.ts's FailedJobLogsFetcher
	 * doc comment for why. Best-effort: any failure here (bad shape, upstream error)
	 * just yields an empty map — report_ci_status treats a lookup miss as "no
	 * logTail for this job", never a hard failure of the whole report.
	 */
	private makeJobLogsFetcher(owner: string, repo: string, token: string): FailedJobLogsFetcher {
		return async (runId, tailLines) => {
			const map = new Map<number, string>();
			try {
				const result = await this.upstream.forward("get_job_logs", { owner, repo, run_id: runId, failed_only: true, return_content: true, tail_lines: tailLines }, token);
				const textBlock = result.content?.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
				if (!textBlock?.text) return map;
				const parsed = JSON.parse(textBlock.text) as { logs?: Array<{ job_id?: unknown; logs_content?: unknown }> };
				for (const entry of parsed.logs ?? []) {
					if (typeof entry.job_id === "number" && typeof entry.logs_content === "string") map.set(entry.job_id, entry.logs_content);
				}
			} catch {
				/* best-effort — see doc comment */
			}
			return map;
		};
	}

	/**
	 * Forwards to the hosted MCP like a plain proxy, then post-processes the result.
	 * gh-broker presents its own MCP contract — a proxied tool's response is not
	 * required to match the hosted MCP's shape verbatim (see [[broker-owns-its-mcp-contract]]
	 * in project memory). `ciVerbosity`/`logLines` are gh-broker's own extension
	 * params, stripped before forwarding since the upstream schema doesn't know them.
	 *
	 * Opt-in only: with no `ciVerbosity`, this is byte-identical to a plain forward —
	 * augmenting every `pull_request_read` call by default would add an unrequested
	 * API call (and cost) to every ordinary PR read.
	 *
	 * Best-effort: if the upstream response isn't the JSON-text shape expected (a
	 * format this broker doesn't control), the original result is returned unmodified
	 * rather than thrown — a shape mismatch should degrade to "no CI data added," not
	 * break an otherwise-successful PR read.
	 */
	private async dispatchAugmented(tool: string, args: Record<string, unknown>, owner: string, token: string): Promise<CallToolResult> {
		switch (tool) {
			case "pull_request_read": {
				const { ciVerbosity, logLines, ...upstreamArgs } = args as Record<string, unknown> & { ciVerbosity?: number; logLines?: number };
				const result = await this.upstream.forward(tool, upstreamArgs, token);
				if (ciVerbosity === undefined) return result;
				if ((upstreamArgs.method ?? "get") !== "get") return result; // only the single-PR "get" shape is augmentable

				const textBlock = result.content?.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
				if (!textBlock?.text) return result;
				let pr: unknown;
				try {
					pr = JSON.parse(textBlock.text);
				} catch {
					return result;
				}
				const p = pr as { number?: unknown; head?: { sha?: unknown } };
				if (typeof p.number !== "number" || typeof p.head?.sha !== "string") return result;

				const repo = String(upstreamArgs.repo ?? "");
				const octokit = new Octokit({ auth: token });
				const ci = await ciStatusForHeadSha(octokit, owner, repo, p.number, p.head.sha, {
					verbosity: Number(ciVerbosity),
					logLines: logLines !== undefined ? Number(logLines) : undefined,
					fetchFailedJobLogs: this.makeJobLogsFetcher(owner, repo, token)
				});
				textBlock.text = JSON.stringify({ ...(pr as object), ci });
				return result;
			}
			default:
				return this.upstream.forward(tool, args, token);
		}
	}
}

/** Derive the repo owner from a tool call's arguments, so we pick the right PAT. */
export function extractOwner(args: Record<string, unknown>): string | undefined {
	if (typeof args.owner === "string" && args.owner) return args.owner.toLowerCase();
	// Many org-scoped tools (list_org_repository_security_advisories, get_team_members, …)
	// name the org as `org` rather than `owner`; for routing, org === owner.
	if (typeof args.org === "string" && args.org) return args.org.toLowerCase();
	if (typeof args.query === "string") {
		const m = args.query.match(/\brepo:([^/\s]+)\/[^\s]+|\b(?:org|user):([^\s]+)/i);
		const hit = m?.[1] ?? m?.[2];
		if (hit) return hit.toLowerCase();
	}
	if (typeof args.repository === "string" && args.repository.includes("/")) {
		return args.repository.split("/")[0]?.toLowerCase();
	}
	return undefined;
}
