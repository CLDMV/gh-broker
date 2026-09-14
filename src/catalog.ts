import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SecretStore } from "./types.ts";
import type { UpstreamPool } from "./upstream.ts";
// DEFERRED: link_issue (addClosingIssueReference) is App-token-only and not wired in — see docs.
// import { LINK_ISSUE_SCHEMA } from "./verbs/link_issue.ts";
import { RESOLVE_REVIEW_THREAD_SCHEMA, REPLY_REVIEW_THREAD_SCHEMA } from "./verbs/review_thread.ts";
import { REPORT_UNLABELED_SCHEMA } from "./verbs/report_unlabeled.ts";

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
			} else if (rule.name === "report_unlabeled") {
				tools.push({
					name: "report_unlabeled",
					description:
						"Report issues and/or PRs with no labels, for one repo or every non-archived repo an owner has. Bounded by maxRepos/perRepoLimit/maxApiCalls; returns truncated:true (with a reason) instead of failing outright if a cap or GitHub's rate limit is hit mid-scan. Runs on the read PAT.",
					inputSchema: REPORT_UNLABELED_SCHEMA
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
		tools.push(up ?? { name: rule.name, description: `(${rule.mode}) proxied to the GitHub MCP`, inputSchema: { type: "object" } });
	}
	return tools;
}
