import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SecretStore, ToolRule } from "./types.ts";
import type { AppAuth } from "./appauth.ts";
import { Octokit } from "@octokit/core";
import { indexTools } from "./config.ts";
import { audit } from "./audit.ts";
// DEFERRED: link_issue is App-token-only and not wired in — see docs.
// import { linkIssue, type LinkIssueInput } from "./verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	type ResolveReviewThreadInput,
	type ReplyReviewThreadInput
} from "./verbs/review_thread.ts";
import { reportUnlabeled, type ReportUnlabeledInput } from "./verbs/report_unlabeled.ts";
import { reportCiStatus, type ReportCiStatusInput } from "./verbs/report_ci_status.ts";

/** What the router needs from the upstream (hosted-MCP) client pool. */
export interface Upstream {
	forward(tool: string, args: Record<string, unknown>, token: string): Promise<CallToolResult>;
}

/**
 * Enforces the default-deny allowlist, resolves the (owner, mode) → PAT, and either
 * forwards to the hosted MCP or dispatches a custom verb. The token never leaves here.
 */
export class Router {
	private readonly rules: Map<string, ToolRule>;

	constructor(
		private readonly config: Config,
		private readonly secrets: SecretStore,
		private readonly upstream: Upstream,
		private readonly appAuth?: AppAuth
	) {
		this.rules = indexTools(config.tools);
	}

	/** Tools advertised to the agent (used to build tools/list). */
	advertisedTools(): ToolRule[] {
		return this.config.tools;
	}

	async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const rule = this.rules.get(tool);
		if (!rule) {
			audit({ tool, decision: "deny", detail: "not in allowlist" });
			throw new Error(`tool "${tool}" is not allowed`);
		}
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

		try {
			const out = rule.custom
				? await this.dispatchCustom(tool, args, owner, token)
				: await this.upstream.forward(tool, args, token);
			audit({ tool, owner, mode: rule.mode, repo, decision: rule.custom ? "custom" : "forward", ok: true });
			return out;
		} catch (err) {
			audit({ tool, owner, mode: rule.mode, repo, decision: rule.custom ? "custom" : "forward", ok: false, detail: (err as Error).message });
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
			case "report_unlabeled": {
				const octokit = new Octokit({ auth: token });
				const out = await reportUnlabeled(octokit, args as unknown as ReportUnlabeledInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			case "report_ci_status": {
				const octokit = new Octokit({ auth: token });
				const out = await reportCiStatus(octokit, args as unknown as ReportCiStatusInput);
				return { content: [{ type: "text", text: JSON.stringify(out) }] };
			}
			default:
				throw new Error(`custom verb "${tool}" not implemented`);
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
