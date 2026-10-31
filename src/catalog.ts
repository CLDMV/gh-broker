/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/catalog.ts
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

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SecretStore } from "./types.ts";
import type { UpstreamPool } from "./upstream.ts";
// DEFERRED: link_issue (addClosingIssueReference) is App-token-only and not wired in — see docs.
// import { LINK_ISSUE_SCHEMA } from "./verbs/link_issue.ts";
import { RESOLVE_REVIEW_THREAD_SCHEMA, REPLY_REVIEW_THREAD_SCHEMA } from "./verbs/review_thread.ts";
import { REPORT_UNLABELED_SCHEMA } from "./verbs/report_unlabeled.ts";
import { REPORT_SECURITY_ALERTS_SCHEMA } from "./verbs/report_security_alerts.ts";
import { REPORT_RELEASE_PRS_SCHEMA } from "./verbs/report_release_prs.ts";
import { ISSUE_LABELS_SCHEMA } from "./verbs/issue_labels.ts";
import { REPORT_CI_STATUS_SCHEMA } from "./verbs/report_ci_status.ts";
import { NPM_SCAFFOLD_SCHEMA } from "./verbs/npm_scaffold.ts";
import { unavailableReason } from "./availability.ts";

/**
 * Build the advertised tool list ONCE at startup. Proxied tools carry their real
 * schemas fetched from the hosted MCP (tool schemas are owner-independent, so any
 * valid read token works — we use the first configured owner's read PAT). Custom
 * verbs carry local schemas. Only allowlisted tools appear; nothing else is
 * advertised (and, per the router, nothing else is executable either).
 *
 * If the upstream fetch fails (network/token), we advertise minimal schemas rather
 * than fail startup — the daemon still serves and calls still route correctly.
 */
export async function buildCatalog(config: Config, secrets: SecretStore, upstream: UpstreamPool): Promise<Tool[]> {
	const upstreamByName = new Map<string, Tool>();
	// Whether the upstream tool list was actually fetched. If it wasn't (network/token), we must NOT drop
	// allowlisted tools — we fall back to minimal schemas so the daemon still serves + routes. But if the
	// fetch DID succeed, a tool missing from it genuinely isn't served by this upstream (wrong toolset /
	// renamed), so advertising a minimal-schema stub only defers the failure to call time (the confusing
	// "could not determine repo owner" → "unknown tool" pair) — better to skip it and say why at startup.
	let upstreamFetched = false;
	const firstOwner = Object.values(config.owners)[0];
	if (firstOwner) {
		try {
			const token = secrets.resolve(firstOwner.read);
			// Never let a slow/unreachable upstream hang startup — fall back to minimal schemas.
			const timeoutMs = Number(process.env.GH_BROKER_CATALOG_TIMEOUT_MS ?? 10000);
			const tools = await Promise.race([
				upstream.listToolsFor(token),
				new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref())
			]);
			for (const t of tools) upstreamByName.set(t.name, t);
			upstreamFetched = true;
		} catch (err) {
			console.error(`catalog: could not fetch upstream tool schemas (${(err as Error).message}) — advertising minimal schemas`);
		}
	}

	const tools: Tool[] = [];
	for (const rule of config.tools) {
		const unavailable = unavailableReason(rule, config, secrets);
		if (unavailable) {
			console.error(`catalog: "${rule.name}" is not exposed: ${unavailable}`);
			continue;
		}
		if (rule.custom) {
			// DEFERRED: link_issue (App-token-only addClosingIssueReference) is not wired in — see docs.
			// Intentionally not advertised even if an allowlist entry is added; re-enable by restoring
			// this branch + the import above + the router dispatch case, then config.app + installationId.
			if (rule.name === "resolve_review_thread") {
				tools.push({
					name: "resolve_review_thread",
					description:
						"Resolve (or unresolve) a pull-request review thread — e.g. mark a Copilot review comment resolved once addressed. Takes the thread node id from pull_request_read get_review_comments. Runs on the write PAT (Pull requests: write).",
					inputSchema: RESOLVE_REVIEW_THREAD_SCHEMA
				});
			} else if (rule.name === "reply_review_thread") {
				tools.push({
					name: "reply_review_thread",
					description:
						"Post a reply inside a pull-request review thread — e.g. respond to a Copilot review comment. Takes the thread node id from pull_request_read get_review_comments. Runs on the write PAT (Pull requests: write).",
					inputSchema: REPLY_REVIEW_THREAD_SCHEMA
				});
			} else if (rule.name === "issue_labels") {
				tools.push({
					name: "issue_labels",
					description:
						'Edit the labels on one issue or PR without touching any other label on it. add / remove take one label or several (combinable in one call); swap { prefix, to } removes every label starting with prefix and adds to (e.g. prefix "status: ", to "status: verified"); set replaces the whole set and only as an explicit choice. Labels already present (add) or absent (remove) are no-ops. A label name to add that does not exist in the repo refuses the call and changes nothing, unless create_missing is true. Returns the resulting label set plus what was added, removed and created. Runs on the write PAT (Issues: write).',
					inputSchema: ISSUE_LABELS_SCHEMA
				});
			} else if (rule.name === "npm_scaffold") {
				tools.push({
					name: "npm_scaffold",
					description:
						"Create a new npm package and register its GitHub Actions trusted publisher, so the repo's publish workflow can release it through OIDC from then on. Publishes a broker-built placeholder (0.0.0-stage, no code) and never publishes a version of an existing package. Every npm write needs its own one-time password from the user, so it takes two calls: the first publishes the placeholder and returns status needs_otp; ask the user for the next code and call again to add the trusted publisher. Ask for each code right before the call. A refused or expired code also returns needs_otp with the remaining steps. Checks first that the repo's package.json names the package and that the workflow file exists. Uses the broker's npm token (no 2FA bypass) and the read PAT.",
					inputSchema: NPM_SCAFFOLD_SCHEMA
				});
			} else if (rule.name === "report_unlabeled") {
				tools.push({
					name: "report_unlabeled",
					description:
						"Report issues and/or PRs with no labels, for one repo or every non-archived repo an owner has. Bounded by maxRepos/perRepoLimit/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit mid-scan. Runs on the read PAT.",
					inputSchema: REPORT_UNLABELED_SCHEMA
				});
			} else if (rule.name === "report_security_alerts") {
				tools.push({
					name: "report_security_alerts",
					description:
						"Report every open Dependabot, code-scanning (CodeQL) and secret-scanning alert, for one repo or across every repo an owner has. Reads the org-level endpoints in a handful of calls and falls back to a per-repo sweep for any alert type the token can't read org-wide. Alert state tracks the default branch. Secret values are never returned. Bounded by maxRepos/alertLimit/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
					inputSchema: REPORT_SECURITY_ALERTS_SCHEMA
				});
			} else if (rule.name === "report_release_prs") {
				tools.push({
					name: "report_release_prs",
					description:
						"Report every open release PR (label `release`: next→master and hotfixes→master) for one repo or across every repo an owner has, and whether each one's per-version changelog file (docs/changelog[s]/v<major>/vX.Y.Z.md) is already on the release branch. Status per PR: ready, needs-changelog, or unknown-version (title has no `release: vX.Y.Z`). Use during mass updates to find which repos need a changelog. One search call plus two calls per release PR found; returns truncated:true with a reason if a cap or GitHub's rate limit is hit. Runs on the read PAT.",
					inputSchema: REPORT_RELEASE_PRS_SCHEMA
				});
			} else if (rule.name === "report_ci_status") {
				tools.push({
					name: "report_ci_status",
					description:
						"Report CI health for a PR, or every open PR in a repo, at a chosen verbosity: 0 counts only, 1 adds which run/job failed, 2 adds which step failed, 3 adds a tail of the failing job's log. Detail beyond tier 0 is only fetched for runs that are actually failing. Runs on the read PAT.",
					inputSchema: REPORT_CI_STATUS_SCHEMA
				});
			}
			continue;
		}
		const up = upstreamByName.get(rule.name);
		if (!up && upstreamFetched) {
			// Reachable upstream that doesn't expose this tool → it would 32602 at call time. Skip + warn.
			console.error(`catalog: allowlisted tool "${rule.name}" is NOT exposed by the upstream (${config.upstream}) — skipping it. Check the tool name or the upstream toolset (e.g. use /mcp/x/all for non-default toolsets like labels).`);
			continue;
		}
		const base = up ?? { name: rule.name, description: `(${rule.mode}) proxied to the GitHub MCP`, inputSchema: { type: "object" } };
		if (rule.augment && rule.name === "pull_request_read") {
			// Layer gh-broker's own extension params onto the real upstream schema — the
			// forwarded call still needs pull_request_read's actual params (method,
			// pullNumber, ...); this ADDS to that, it doesn't replace it. See router.ts's
			// dispatchAugmented for why gh-broker can extend a proxied tool's contract.
			const baseSchema = base.inputSchema as { properties?: Record<string, unknown>; [k: string]: unknown };
			tools.push({
				...base,
				description: `${base.description} gh-broker extension: with method "get", pass "ciVerbosity" (0-3) to also compute CI status for the PR's current head — 0 counts only, 1 adds which run/job failed, 2 adds which step failed, 3 adds a tail of the failing job's log; "logLines" tunes tier 3's tail length.`,
				inputSchema: {
					...baseSchema,
					type: "object",
					properties: {
						...(baseSchema.properties ?? {}),
						ciVerbosity: { type: "number", enum: [0, 1, 2, 3], description: 'gh-broker extension: also compute CI status at this verbosity (method "get" only)' },
						logLines: { type: "number", description: "gh-broker extension: tier-3 log tail length" }
					}
				}
			});
			continue;
		}
		if (rule.name === "issue_write") {
			// issue_write's `labels` REPLACES the issue's whole label set — the trap behind
			// CLDMV/gh-broker#117. Say so where the agent reads the tool, and point at the verb
			// that edits labels one at a time when it is allowlisted.
			const pointer = config.tools.some((t) => t.name === "issue_labels" && t.custom)
				? " To add, remove or swap individual labels, use issue_labels instead."
				: " Read the current labels first and pass the full set you want to keep.";
			tools.push({
				...base,
				description: `${base.description ?? ""} WARNING (gh-broker): "labels" REPLACES the issue's whole label set — every label not listed is removed.${pointer}`.trim()
			});
			continue;
		}
		tools.push(base);
	}
	return tools;
}
