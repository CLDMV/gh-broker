/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/catalog.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-19T19:45:12-08:00 (1795146312)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NO_PERSON, type Config, type TokenResolver, type ToolRule } from "./types.ts";
import { MANIFEST } from "./manifest.ts";
import { unavailableReason } from "./availability.ts";
import { OTP_ARG, isGated, otpSettings, windowText } from "./otp-policy.ts";

/**
 * What the catalog needs from the daemon's upstream client pool (design #175 §2a): the
 * upstream tool-list fetch the schema build races against the timeout. Structural on
 * purpose — the daemon injects its pooled UpstreamPool (src/upstream.ts); a library host
 * injects anything that fetches the same way. Declared here instead of imported from
 * the host module so the library's import graph stays inside src/core/.
 */
interface CatalogUpstream {
	listToolsFor(token: string): Promise<Tool[]>;
}

export interface CatalogOpts {
	/**
	 * The upstream schema-fetch timeout in ms. Absent: 10000 (the env read that used to
	 * supply it died with the SecretStore-compat shape — a caller that wants the env's
	 * value passes it explicitly, as the daemon does).
	 */
	upstreamTimeoutMs?: number;
	/**
	 * Operator-facing log sink for the catalog's startup messages. Absent: silent (a
	 * library host composes its own logging; the daemon passes its stderr/journald sink).
	 */
	log?: (message: string) => void;
	/**
	 * The capability predicate (design §2's seam table): why a tool rule can't be served
	 * on this host, or undefined when it can. Absent: only the structural facts a
	 * dispatch would crash on are checked — the host applies its own availability policy
	 * before building a catalog.
	 */
	unavailable?: (rule: ToolRule) => string | undefined;
}

/**
 * Build the advertised tool list ONCE at startup. Proxied tools carry their real
 * schemas fetched from the hosted MCP (tool schemas are owner-independent, so any
 * valid read token works — the daemon's resolver yields the first configured owner's
 * read PAT). Custom verbs carry local schemas. Only allowlisted tools appear; nothing
 * else is advertised (and, per the router, nothing else is executable either).
 *
 * If the upstream fetch fails (network/token), we advertise minimal schemas rather
 * than fail startup — the daemon still serves and calls still route correctly.
 */
export async function buildCatalog(config: Config, resolveToken: TokenResolver, upstream: CatalogUpstream, opts: CatalogOpts = {}): Promise<Tool[]> {
	// Absent opts are env-free and silent (a library host is Quack-safe); the daemon
	// passes its env-derived timeout, stderr sink and availability predicate explicitly.
	const timeoutMs = opts.upstreamTimeoutMs ?? 10000;
	const log = opts.log;
	const unavailable = opts.unavailable;

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
			// The library's only credential path: the resolver decides what the schema fetch
			// may use. The catalog has no person of its own (schemas are owner-independent):
			// the request carries the NO_PERSON marker (src/types.ts) and the first configured
			// owner as the owner, so the daemon's owner-honoring resolver yields its read PAT.
			const token = await resolveToken({ person: NO_PERSON, owner: Object.keys(config.owners)[0], mode: "read", kind: "github" });
			if (!token) throw new Error("the token resolver returned no token");
			// Never let a slow/unreachable upstream hang startup — fall back to minimal schemas.
			const tools = await Promise.race([
				upstream.listToolsFor(token),
				new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref())
			]);
			for (const t of tools) upstreamByName.set(t.name, t);
			upstreamFetched = true;
		} catch (err) {
			log?.(`catalog: could not fetch upstream tool schemas (${(err as Error).message}) — advertising minimal schemas`);
		}
	}

	const tools: Tool[] = [];
	for (const rule of config.tools) {
		const why = unavailable?.(rule);
		if (why) {
			log?.(`catalog: "${rule.name}" is not exposed: ${why}`);
			continue;
		}
		if (rule.custom) {
			// The manifest is the declaration source for the wired verbs: description and
			// schema come from its verb entry (moved here verbatim when the manifest landed).
			// DEFERRED: link_issue (App-token-only addClosingIssueReference) is not wired in — see docs.
			// It has no manifest entry, so it is intentionally not advertised even if an
			// allowlist entry is added; re-enable by adding the manifest entry + the router
			// dispatch case, then config.app + installationId.
			const decl = Object.hasOwn(MANIFEST, rule.name) ? MANIFEST[rule.name] : undefined;
			if (decl?.kind === "verb") {
				tools.push({ name: rule.name, description: decl.description, inputSchema: decl.inputSchema });
			}
			continue;
		}
		const up = upstreamByName.get(rule.name);
		if (!up && upstreamFetched) {
			// Reachable upstream that doesn't expose this tool → it would 32602 at call time. Skip + warn.
			log?.(`catalog: allowlisted tool "${rule.name}" is NOT exposed by the upstream (${config.upstream}) — skipping it. Check the tool name or the upstream toolset (e.g. use /mcp/x/all for non-default toolsets like labels).`);
			continue;
		}
		const base = up ?? { name: rule.name, description: `(${rule.mode}) proxied to the GitHub MCP`, inputSchema: { type: "object" } };
		if (rule.augment && (rule.name === "pull_request_read" || rule.name === "list_pull_requests")) {
			// Layer gh-broker's own extension params onto the real upstream schema — the
			// forwarded call still needs pull_request_read's actual params (method,
			// pullNumber, ...); this ADDS to that, it doesn't replace it. See router.ts's
			// dispatchAugmented for why gh-broker can extend a proxied tool's contract.
			const baseSchema = base.inputSchema as { properties?: Record<string, unknown>; [k: string]: unknown };
			if (rule.name === "list_pull_requests") {
				tools.push({
					...base,
					description: `${base.description} gh-broker extension: pass "ciVerbosity" (0-3) to add a "ci" field to each listed PR — 0 counts only, 1 adds which run/job failed, 2 adds which step failed, 3 adds a tail of the failing job's log. Costs at least one API call per listed PR; detail (1-3) is only fetched for the first "maxDetail" PRs (default 10, max 50), and later PRs carry counts with truncated:true. "logLines" tunes tier 3's tail length.`,
					inputSchema: {
						...baseSchema,
						type: "object",
						properties: {
							...(baseSchema.properties ?? {}),
							ciVerbosity: { type: "number", enum: [0, 1, 2, 3], description: "gh-broker extension: add a ci field to each listed PR at this verbosity" },
							logLines: { type: "number", description: "gh-broker extension: tier-3 log tail length" },
							maxDetail: { type: "number", description: "gh-broker extension: how many PRs get tier 1-3 detail (default 10, hard cap 50)" }
						}
					}
				});
				continue;
			}
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
		if (rule.name === "create_repository" || rule.name === "fork_repository") {
			// The router refuses these without an organization (and create_repository without an
			// explicit private), so the schema says the same.
			const schema = base.inputSchema as { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
			const needed = rule.name === "create_repository" ? ["organization", "private"] : ["organization"];
			const note =
				rule.name === "create_repository"
					? ' gh-broker: "organization" and "private" are required; the repo is never created in a personal account or left public by default.'
					: ' gh-broker: "organization" (where the fork goes) is required; forks are never created in a personal account.';
			tools.push({
				...base,
				description: `${base.description ?? ""}${note}`.trim(),
				inputSchema: { ...schema, type: "object", required: [...new Set([...(schema.required ?? []), ...needed])] } as Tool["inputSchema"]
			});
			continue;
		}
		if (rule.name === "actions_run_trigger") {
			tools.push({ ...base, description: `${base.description ?? ""} gh-broker: method "delete_workflow_run_logs" is refused; a run's logs are kept.`.trim() });
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
	return withOtp(tools, config);
}

/**
 * Gated tools take a required "otp" and say so in their description. The schema is
 * copied, never mutated: it can be the upstream's object or a verb's shared constant.
 */
function withOtp(tools: Tool[], config: Config): Tool[] {
	const gated = new Set(config.tools.filter(isGated).map((t) => t.name));
	const window = windowText(otpSettings(config).windowSeconds);
	return tools.map((tool) => {
		if (!gated.has(tool.name)) return tool;
		const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
		return {
			...tool,
			description: `${tool.description ?? ""} Needs a broker OTP (gh-broker): ask the user for a current code from their authenticator app and pass it as "${OTP_ARG}". One code works for every gated tool for ${window} after the first call that uses it.`.trim(),
			inputSchema: {
				...schema,
				type: "object",
				properties: {
					...(schema.properties ?? {}),
					[OTP_ARG]: { type: "string", description: "gh-broker: a current 6-digit code from the user's authenticator app, or the code that opened the current window" }
				},
				required: [...(schema.required ?? []).filter((r) => r !== OTP_ARG), OTP_ARG]
			}
		};
	});
}
