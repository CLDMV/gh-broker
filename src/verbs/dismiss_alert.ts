/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/dismiss_alert.ts
 *	@Date: 2026-11-02T19:56:12-08:00 (1793678172)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T20:12:06-08:00 (1793679126)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";

/**
 * Custom verb: dismiss_alert — dismiss (or reopen) one code scanning, Dependabot or secret
 * scanning alert. Gated by default (#146). Upstream only reads alerts; these are the three REST
 * PATCH endpoints, on the write PAT (Code scanning alerts / Dependabot alerts / Secret scanning
 * alerts: write).
 *
 * Each kind has its own reason vocabulary, and a dismissal needs one. A secret scanning alert's
 * response carries the secret itself, so the answer is built from a fixed set of fields and the
 * secret never leaves this file.
 */

export const ALERT_KINDS = ["code_scanning", "dependabot", "secret_scanning"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The reasons GitHub accepts, per kind, as the API spells them. */
export const DISMISS_REASONS: Record<AlertKind, readonly string[]> = {
	code_scanning: ["false positive", "won't fix", "used in tests"],
	dependabot: ["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"],
	secret_scanning: ["false_positive", "wont_fix", "revoked", "used_in_tests"]
};

export interface DismissAlertInput {
	owner: string;
	repo: string;
	kind: AlertKind;
	alertNumber: number;
	/** Required unless reopening; one of DISMISS_REASONS[kind]. */
	reason?: string;
	comment?: string;
	/** true reopens a dismissed (or resolved) alert instead. */
	reopen?: boolean;
}

export interface DismissAlertResult {
	kind: AlertKind;
	number: number;
	state: string;
	reason: string | null;
	url: string | null;
}

const ROUTES: Record<AlertKind, string> = {
	code_scanning: "PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}",
	dependabot: "PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}",
	secret_scanning: "PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"
};

/** The request body for one kind. Secret scanning says resolved/resolution where the others say dismissed. */
function bodyFor(kind: AlertKind, reopen: boolean, reason: string | undefined, comment: string | undefined): Record<string, unknown> {
	if (kind === "secret_scanning") {
		if (reopen) return { state: "open", ...(comment ? { resolution_comment: comment } : {}) };
		return { state: "resolved", resolution: reason, ...(comment ? { resolution_comment: comment } : {}) };
	}
	if (reopen) return { state: "open" };
	return { state: "dismissed", dismissed_reason: reason, ...(comment ? { dismissed_comment: comment } : {}) };
}

export async function dismissAlert(octokit: Octokit, input: DismissAlertInput): Promise<DismissAlertResult> {
	const { owner, repo, kind } = input;
	if (typeof repo !== "string" || !repo) throw new Error("dismiss_alert: repo is required");
	if (!ALERT_KINDS.includes(kind)) throw new Error(`dismiss_alert: kind must be one of ${ALERT_KINDS.join(", ")}`);
	if (!Number.isSafeInteger(input.alertNumber) || input.alertNumber <= 0) throw new Error("dismiss_alert: alertNumber must be a positive integer");
	if (input.comment !== undefined && typeof input.comment !== "string") throw new Error("dismiss_alert: comment must be a string");
	const reopen = input.reopen === true;
	if (reopen && input.reason !== undefined) throw new Error("dismiss_alert: a reopen takes no reason");
	if (reopen && input.comment !== undefined && kind !== "secret_scanning") throw new Error(`dismiss_alert: GitHub stores no comment when a ${kind} alert is reopened; leave comment out`);
	if (!reopen && !DISMISS_REASONS[kind].includes(input.reason as string)) {
		throw new Error(`dismiss_alert: reason is required for a ${kind} alert, one of: ${DISMISS_REASONS[kind].map((r) => `"${r}"`).join(", ")}`);
	}

	const res = await octokit.request(ROUTES[kind], { owner, repo, alert_number: input.alertNumber, ...bodyFor(kind, reopen, input.reason, input.comment) });
	// Only these fields leave: a secret scanning alert also carries the secret.
	const d = res.data as { number?: unknown; state?: unknown; dismissed_reason?: unknown; resolution?: unknown; html_url?: unknown };
	const reason = kind === "secret_scanning" ? d.resolution : d.dismissed_reason;
	return {
		kind,
		number: typeof d.number === "number" ? d.number : input.alertNumber,
		state: typeof d.state === "string" ? d.state : "unknown",
		reason: typeof reason === "string" ? reason : null,
		url: typeof d.html_url === "string" ? d.html_url : null
	};
}

export const DISMISS_ALERT_DESCRIPTION = `Dismiss one code scanning, Dependabot or secret scanning alert, or reopen it with reopen: true. A dismissal needs a reason, which depends on kind: code_scanning ${DISMISS_REASONS.code_scanning.map((r) => `"${r}"`).join(" / ")}; dependabot ${DISMISS_REASONS.dependabot.join(" / ")}; secret_scanning ${DISMISS_REASONS.secret_scanning.join(" / ")}. Returns the alert's number, state, reason and URL only; a secret's value is never returned. Runs on the write PAT.`;

export const DISMISS_ALERT_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "kind", "alertNumber"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login); selects the write credential" },
		repo: { type: "string", description: "repository name" },
		kind: { type: "string", enum: [...ALERT_KINDS], description: "which alert type" },
		alertNumber: { type: "number", description: "the alert number" },
		reason: { type: "string", description: "why it's dismissed; the accepted values depend on kind (see the description)" },
		comment: { type: "string", description: "optional note stored with the dismissal" },
		reopen: { type: "boolean", description: "true reopens the alert instead of dismissing it (no reason)" }
	}
};
