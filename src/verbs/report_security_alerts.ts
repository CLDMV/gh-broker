/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_security_alerts.ts
 *	@Date: 2026-10-03T05:10:00+00:00 (1791004200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-03T05:10:00+00:00 (1791004200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, listOwnerRepos, paginate, paginateAfter } from "./rest-client.ts";
import { classifyRepo, type RepoTier } from "./repo-tier.ts";

/**
 * Custom verb: report_security_alerts — every OPEN Dependabot, code-scanning (CodeQL)
 * and secret-scanning alert, for one repo or across everything an owner has.
 *
 * Why a custom verb: the hosted GitHub MCP's alert tools are single-repo, so "what is
 * open across the org" means one call per repo per alert type. This verb asks the
 * org-level endpoints first (one paginated call per alert type for the whole org) and
 * only falls back to a per-repo sweep for an alert type when the org endpoint isn't
 * available to the token (a user-owned account, or a PAT without org alert access).
 *
 * Alert state caveat: an alert's state tracks the default branch, so "open" here is
 * the default-branch view. An alert already fixed on a staging branch (`next`) but not
 * yet released still reads as open until the release lands.
 *
 * Secrets: only metadata is reported (type, validity, location of the alert) — the
 * secret value GitHub returns is deliberately dropped and never leaves this module.
 *
 * Fan-out safety mirrors report_unlabeled (see rest-client.ts): `maxRepos`,
 * `alertLimit` and `maxApiCalls` cap the work; hitting a cap or GitHub's rate limit
 * returns whatever was found with `truncated: true` and a reason.
 */

export type AlertType = "dependabot" | "codeql" | "secrets";

const ALL_TYPES: AlertType[] = ["dependabot", "codeql", "secrets"];

export interface ReportSecurityAlertsInput {
	owner: string;
	/** Repo name; omit to cover every non-archived repo the owner has. */
	repo?: string;
	/** Which alert types to read. Default: all three. */
	types?: AlertType[];
	/** Safety cap on repos swept per-repo when the org endpoint is unavailable. Default 200, hard-capped at 500. */
	maxRepos?: number;
	/** Safety cap on alerts fetched per alert type (org mode) or per repo per type (per-repo mode). Default 500, hard-capped at 5000. */
	alertLimit?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 700, hard-capped at 3000. */
	maxApiCalls?: number;
	/** Return only the per-repo roll-up (`byRepo`) and the counts, not the alert list. An org run is ~700 KB with the list; the roll-up is a few KB. */
	summaryOnly?: boolean;
	/** Keep only alerts at or above this severity (secret-scanning alerts have no severity and are always kept). */
	minSeverity?: "critical" | "high" | "medium" | "low";
	/** Keep only these repos (names, with or without the owner prefix). */
	repos?: string[];
	/** Add each repo's flow tier (`v4` / `dev-trunk` / `non-v4`, plus the raw signals) to `byRepo`. Costs about 3 REST calls per repo that has alerts. */
	classify?: boolean;
}

export interface RepoRollup {
	repo: string;
	total: number;
	dependabot: number;
	codeql: number;
	secrets: number;
	critical: number;
	high: number;
	medium: number;
	low: number;
	/** Only with `classify: true`; absent for a repo that could not be classified before a cap was hit. */
	tier?: RepoTier["tier"];
	tierSignals?: RepoTier["signals"];
}

export interface SecurityAlert {
	repo: string;
	type: AlertType;
	number: number;
	severity: string;
	summary: string;
	url: string;
	createdAt: string;
	/** Dependabot only. */
	package?: string;
	ecosystem?: string;
	manifest?: string;
	scope?: string;
	ghsa?: string;
	cve?: string;
	vulnerableRange?: string;
	patchedVersion?: string;
	/** Code scanning only. */
	rule?: string;
	tool?: string;
	location?: string;
	/** Secret scanning only. */
	secretType?: string;
	validity?: string;
}

export type SecurityTruncatedReason = "max-repos" | "max-alerts" | "max-api-calls" | "rate-limited";

export interface ReportSecurityAlertsResult {
	/** Set only when a per-repo sweep ran. */
	scanned: { repos?: number };
	/** How each requested type was read: one org-level call set, or a per-repo sweep. */
	scope: Partial<Record<AlertType, "org" | "per-repo">>;
	/** Open alerts per type, keyed by severity (secrets are keyed `open`). */
	counts: Partial<Record<AlertType, Record<string, number>>>;
	/** One row per repo with at least one alert, worst first (criticals, then highs, then total). */
	byRepo: RepoRollup[];
	/** Empty when `summaryOnly` is set; see `alertsOmitted`. */
	alerts: SecurityAlert[];
	/** Set with `summaryOnly`: how many alerts were left out of `alerts`. */
	alertsOmitted?: number;
	/** Per-repo sweep only: repos where an alert type is switched off or not readable, per type. Omitted when none. */
	disabled?: Partial<Record<AlertType, number>>;
	truncated?: boolean;
	truncatedReason?: SecurityTruncatedReason;
	/** Only set when truncatedReason is "rate-limited" and GitHub sent a Retry-After. */
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_REPOS = 200;
const HARD_MAX_REPOS = 500;
const DEFAULT_ALERT_LIMIT = 500;
const HARD_ALERT_LIMIT = 5000;
const DEFAULT_MAX_API_CALLS = 700;
const HARD_MAX_API_CALLS = 3000;

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, error: 1, medium: 2, moderate: 2, warning: 3, low: 4, note: 5 };

interface RawRepository {
	name?: string;
	full_name?: string;
}

interface RawDependabot {
	number: number;
	html_url: string;
	created_at: string;
	repository?: RawRepository;
	dependency?: { package?: { ecosystem?: string; name?: string }; manifest_path?: string; scope?: string };
	security_advisory?: { ghsa_id?: string; cve_id?: string | null; summary?: string; severity?: string };
	security_vulnerability?: { severity?: string; vulnerable_version_range?: string; first_patched_version?: { identifier?: string } | null };
}

interface RawCodeql {
	number: number;
	html_url: string;
	created_at: string;
	repository?: RawRepository;
	rule?: { id?: string; severity?: string; security_severity_level?: string; description?: string };
	tool?: { name?: string };
	most_recent_instance?: { location?: { path?: string; start_line?: number } };
}

interface RawSecret {
	number: number;
	html_url: string;
	created_at: string;
	repository?: RawRepository;
	secret_type?: string;
	secret_type_display_name?: string;
	validity?: string;
	// `secret` (the value) is intentionally not modelled — see the module doc.
}

function normalizeDependabot(owner: string, repo: string, a: RawDependabot): SecurityAlert {
	const vuln = a.security_vulnerability;
	const out: SecurityAlert = {
		repo: a.repository?.full_name ?? `${owner}/${repo}`,
		type: "dependabot",
		number: a.number,
		severity: vuln?.severity ?? a.security_advisory?.severity ?? "unknown",
		summary: a.security_advisory?.summary ?? "",
		url: a.html_url,
		createdAt: a.created_at
	};
	if (a.dependency?.package?.name) out.package = a.dependency.package.name;
	if (a.dependency?.package?.ecosystem) out.ecosystem = a.dependency.package.ecosystem;
	if (a.dependency?.manifest_path) out.manifest = a.dependency.manifest_path;
	if (a.dependency?.scope) out.scope = a.dependency.scope;
	if (a.security_advisory?.ghsa_id) out.ghsa = a.security_advisory.ghsa_id;
	if (a.security_advisory?.cve_id) out.cve = a.security_advisory.cve_id;
	if (vuln?.vulnerable_version_range) out.vulnerableRange = vuln.vulnerable_version_range;
	if (vuln?.first_patched_version?.identifier) out.patchedVersion = vuln.first_patched_version.identifier;
	return out;
}

function normalizeCodeql(owner: string, repo: string, a: RawCodeql): SecurityAlert {
	const out: SecurityAlert = {
		repo: a.repository?.full_name ?? `${owner}/${repo}`,
		type: "codeql",
		number: a.number,
		severity: a.rule?.security_severity_level ?? a.rule?.severity ?? "unknown",
		summary: a.rule?.description ?? "",
		url: a.html_url,
		createdAt: a.created_at
	};
	if (a.rule?.id) out.rule = a.rule.id;
	if (a.tool?.name) out.tool = a.tool.name;
	const loc = a.most_recent_instance?.location;
	if (loc?.path) out.location = loc.start_line !== undefined ? `${loc.path}:${loc.start_line}` : loc.path;
	return out;
}

function normalizeSecret(owner: string, repo: string, a: RawSecret): SecurityAlert {
	const out: SecurityAlert = {
		repo: a.repository?.full_name ?? `${owner}/${repo}`,
		type: "secrets",
		number: a.number,
		severity: "open",
		summary: a.secret_type_display_name ?? a.secret_type ?? "",
		url: a.html_url,
		createdAt: a.created_at
	};
	if (a.secret_type) out.secretType = a.secret_type;
	if (a.validity) out.validity = a.validity;
	return out;
}

interface TypeSpec {
	orgRoute: string;
	repoRoute: string;
	/** Dependabot's endpoints are cursor-paginated; the other two take `page`. */
	cursor: boolean;
	normalize: (owner: string, repo: string, raw: never) => SecurityAlert;
}

const SPECS: Record<AlertType, TypeSpec> = {
	dependabot: {
		orgRoute: "GET /orgs/{owner}/dependabot/alerts",
		repoRoute: "GET /repos/{owner}/{repo}/dependabot/alerts",
		cursor: true,
		normalize: normalizeDependabot as TypeSpec["normalize"]
	},
	codeql: {
		orgRoute: "GET /orgs/{owner}/code-scanning/alerts",
		repoRoute: "GET /repos/{owner}/{repo}/code-scanning/alerts",
		cursor: false,
		normalize: normalizeCodeql as TypeSpec["normalize"]
	},
	secrets: {
		orgRoute: "GET /orgs/{owner}/secret-scanning/alerts",
		repoRoute: "GET /repos/{owner}/{repo}/secret-scanning/alerts",
		cursor: false,
		normalize: normalizeSecret as TypeSpec["normalize"]
	}
};

/** A 403/404 from an alert endpoint means "not available to this token / switched off here", not a failure. */
function isUnavailable(err: unknown): boolean {
	const status = (err as { status?: number }).status;
	return status === 403 || status === 404;
}

async function fetchRaw(octokit: Octokit, budget: CallBudget, spec: TypeSpec, route: string, params: Record<string, unknown>, limit: number): Promise<unknown[]> {
	const query = { ...params, state: "open" };
	return spec.cursor ? paginateAfter<unknown>(octokit, budget, route, query, limit) : paginate<unknown>(octokit, budget, route, query, limit);
}

function severityRank(s: string): number {
	return SEVERITY_RANK[s.toLowerCase()] ?? 6;
}

export async function reportSecurityAlerts(octokit: Octokit, input: ReportSecurityAlertsInput): Promise<ReportSecurityAlertsResult> {
	const types = input.types && input.types.length > 0 ? ALL_TYPES.filter((t) => input.types!.includes(t)) : ALL_TYPES;
	const maxRepos = Math.min(input.maxRepos ?? DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
	const alertLimit = Math.min(input.alertLimit ?? DEFAULT_ALERT_LIMIT, HARD_ALERT_LIMIT);
	const maxApiCalls = Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS);
	const budget = new CallBudget(maxApiCalls);

	const alerts: SecurityAlert[] = [];
	const scope: ReportSecurityAlertsResult["scope"] = {};
	const scanned: ReportSecurityAlertsResult["scanned"] = {};
	const disabled: Partial<Record<AlertType, number>> = {};
	let truncatedReason: SecurityTruncatedReason | undefined;
	let retryAfterSeconds: number | undefined;

	const addAll = (type: AlertType, owner: string, repo: string, raws: unknown[]) => {
		const spec = SPECS[type];
		for (const raw of raws) alerts.push(spec.normalize(owner, repo, raw as never));
	};

	try {
		// Which types still need a per-repo sweep (org endpoint unavailable, or a single repo was asked for).
		let sweep: AlertType[] = [];
		if (input.repo) {
			sweep = types;
		} else {
			for (const type of types) {
				try {
					const raws = await fetchRaw(octokit, budget, SPECS[type], SPECS[type].orgRoute, { owner: input.owner }, alertLimit);
					scope[type] = "org";
					if (raws.length >= alertLimit) truncatedReason ??= "max-alerts";
					addAll(type, input.owner, "", raws);
				} catch (err) {
					if (!isUnavailable(err)) throw err;
					sweep.push(type);
				}
			}
		}

		if (sweep.length > 0) {
			let repos: string[];
			if (input.repo) {
				repos = [input.repo];
			} else {
				// One past the cap, so "exactly maxRepos repos" can be told apart from "more than maxRepos".
				const listed = await listOwnerRepos(octokit, budget, input.owner, maxRepos + 1);
				if (listed.length > maxRepos) truncatedReason ??= "max-repos";
				repos = listed.slice(0, maxRepos);
			}
			scanned.repos = repos.length;
			for (const type of sweep) scope[type] = "per-repo";

			for (const repo of repos) {
				for (const type of sweep) {
					try {
						const raws = await fetchRaw(octokit, budget, SPECS[type], SPECS[type].repoRoute, { owner: input.owner, repo }, alertLimit);
						if (raws.length >= alertLimit) truncatedReason ??= "max-alerts";
						addAll(type, input.owner, repo, raws);
					} catch (err) {
						if (!isUnavailable(err)) throw err;
						disabled[type] = (disabled[type] ?? 0) + 1;
					}
				}
			}
		}
	} catch (err) {
		if (err instanceof RateLimited) {
			truncatedReason = "rate-limited";
			retryAfterSeconds = err.retryAfterSeconds;
		} else if (err instanceof CallBudgetExhausted) {
			truncatedReason = "max-api-calls";
		} else {
			throw err;
		}
	}

	// Filters run after fetching: the API has no cross-type severity or repo-list filter.
	const minRank = input.minSeverity ? { critical: 0, high: 1, medium: 2, low: 4 }[input.minSeverity] : undefined;
	const wanted = input.repos?.length ? new Set(input.repos.map((r) => r.replace(/^[^/]+\//, "").toLowerCase())) : undefined;
	for (let i = alerts.length - 1; i >= 0; i--) {
		const a = alerts[i]!;
		const name = a.repo.replace(/^[^/]+\//, "").toLowerCase();
		if (wanted && !wanted.has(name)) alerts.splice(i, 1);
		else if (minRank !== undefined && a.type !== "secrets" && severityRank(a.severity) > minRank) alerts.splice(i, 1);
	}

	alerts.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.repo.localeCompare(b.repo) || a.number - b.number);

	const counts: ReportSecurityAlertsResult["counts"] = {};
	for (const type of types) {
		if (scope[type] === undefined) continue; // never read (truncated before this type) — don't claim a zero count
		const byType: Record<string, number> = {};
		for (const a of alerts) if (a.type === type) byType[a.severity] = (byType[a.severity] ?? 0) + 1;
		counts[type] = byType;
	}

	const rollup = new Map<string, RepoRollup>();
	for (const a of alerts) {
		let row = rollup.get(a.repo);
		if (!row) {
			row = { repo: a.repo, total: 0, dependabot: 0, codeql: 0, secrets: 0, critical: 0, high: 0, medium: 0, low: 0 };
			rollup.set(a.repo, row);
		}
		row.total++;
		row[a.type]++;
		const r = severityRank(a.severity);
		if (r === 0) row.critical++;
		else if (r === 1) row.high++;
		else if (r === 2) row.medium++;
		else if (r >= 3 && r <= 5) row.low++;
	}
	const byRepo = [...rollup.values()].sort((a, b) => b.critical - a.critical || b.high - a.high || b.total - a.total || a.repo.localeCompare(b.repo));

	if (input.classify) {
		try {
			for (const row of byRepo) {
				const [owner, repo] = row.repo.includes("/") ? row.repo.split("/") : [input.owner, row.repo];
				const t = await classifyRepo(octokit, budget, owner!, repo!);
				row.tier = t.tier;
				row.tierSignals = t.signals;
			}
		} catch (err) {
			if (err instanceof RateLimited) {
				truncatedReason = "rate-limited";
				retryAfterSeconds = err.retryAfterSeconds;
			} else if (err instanceof CallBudgetExhausted) {
				truncatedReason = "max-api-calls";
			} else {
				throw err;
			}
		}
	}

	const omitted = input.summaryOnly ? alerts.length : undefined;
	return {
		scanned,
		scope,
		counts,
		byRepo,
		alerts: input.summaryOnly ? [] : alerts,
		...(omitted !== undefined ? { alertsOmitted: omitted } : {}),
		...(Object.keys(disabled).length > 0 ? { disabled } : {}),
		...(truncatedReason ? { truncated: true, truncatedReason } : {}),
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
	};
}

/** JSON Schema advertised to the agent for report_security_alerts. */
export const REPORT_SECURITY_ALERTS_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "repository name; omit to cover every non-archived repo this owner has" },
		types: {
			type: "array",
			items: { type: "string", enum: ["dependabot", "codeql", "secrets"] },
			description: "which alert types to read (default: all three)"
		},
		maxRepos: { type: "number", description: `safety cap on repos swept per-repo when the org-level endpoint is unavailable (default ${DEFAULT_MAX_REPOS}, hard cap ${HARD_MAX_REPOS})` },
		alertLimit: { type: "number", description: `safety cap on alerts fetched per type (org mode) or per repo per type (default ${DEFAULT_ALERT_LIMIT}, hard cap ${HARD_ALERT_LIMIT})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` },
		summaryOnly: { type: "boolean", description: "return only the per-repo roll-up (byRepo) and counts, not the alert list — a few KB instead of ~700 KB for a whole org", default: false },
		minSeverity: { type: "string", enum: ["critical", "high", "medium", "low"], description: "keep only alerts at or above this severity (secret-scanning alerts are always kept)" },
		repos: { type: "array", items: { type: "string" }, description: "keep only these repos (names, with or without the owner prefix)" },
		classify: { type: "boolean", description: "add each repo's flow tier (v4 / dev-trunk / non-v4) and the raw signals to byRepo; about 3 REST calls per repo with alerts", default: false }
	}
};
