import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, SecretStore } from "./types.ts";
import type { UpstreamPool } from "./upstream.ts";
import { LINK_ISSUE_SCHEMA } from "./verbs/link_issue.ts";

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
		} catch (err) {
			console.error(`catalog: could not fetch upstream tool schemas (${(err as Error).message}) — advertising minimal schemas`);
		}
	}

	const tools: Tool[] = [];
	for (const rule of config.tools) {
		if (rule.custom) {
			if (rule.name === "link_issue") {
				tools.push({
					name: "link_issue",
					description: "Create an explicit PR→issue closing reference (addClosingIssueReference) so the issue auto-closes when the PR's changes reach the default branch. Does not rely on commit-message keywords.",
					inputSchema: LINK_ISSUE_SCHEMA
				});
			}
			continue;
		}
		const up = upstreamByName.get(rule.name);
		tools.push(up ?? { name: rule.name, description: `(${rule.mode}) proxied to the GitHub MCP`, inputSchema: { type: "object" } });
	}
	return tools;
}
