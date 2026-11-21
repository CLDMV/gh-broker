/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/index.ts
 *	@Date: 2026-11-14T13:55:00-08:00 (1794693300)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:55:00-08:00 (1794693300)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library's public surface (design #175 §1's library rows): the shared vocabulary,
 * the config parser's library half, the gating policy, the manifest + the two policies,
 * the catalog and availability, the denylist, the agent-name rules, the router core's
 * seams and dispatch functions, the invoke entry (createBroker / invoke / run /
 * perCallUpstream), and the pure verbs. Published by the exports map's `.` and `./core`
 * entries (slice 6, §6). The daemon's host modules stay outside this barrel.
 */

// Vocabulary + policies.
export * from "./types.ts";
export * from "./agents.ts";
export * from "./otp-policy.ts";
export * from "./denylist.ts";
export * from "./availability.ts";
export * from "./config.ts";
export * from "./manifest.ts";
export * from "./catalog.ts";
export * from "./router-core.ts";

// The public entry (design #175 §2b): createBroker's bound invoke/run, the typed
// InvokeError, the per-call Upstream forwarder, and the ctx/result types.
export * from "./invoke.ts";

// The pure verbs, mirroring the verbs/ layout.
export * from "./verbs/delete_branch.ts";
export * from "./verbs/dismiss_alert.ts";
export * from "./verbs/issue_labels.ts";
export * from "./verbs/link_issue.ts";
export * from "./verbs/lockfile.ts";
export * from "./verbs/minimize_comment.ts";
export * from "./verbs/npm-registry.ts";
export * from "./verbs/npm-tarball.ts";
export * from "./verbs/npm_scaffold.ts";
export * from "./verbs/otp_status.ts";
export * from "./verbs/release-analysis.ts";
export * from "./verbs/report_alert_status.ts";
export * from "./verbs/report_ci_status.ts";
export * from "./verbs/report_dependents.ts";
export * from "./verbs/report_release_changes.ts";
export * from "./verbs/report_release_prs.ts";
export * from "./verbs/report_security_alerts.ts";
export * from "./verbs/repo-tier.ts";
export * from "./verbs/rest-client.ts";
export * from "./verbs/review_thread.ts";
export * from "./verbs/ghcr/config.ts";
export * from "./verbs/ghcr/schemas.ts";

// report_unlabeled's TruncatedReason collides on the barrel with report_ci_status's
// same-named but different union ("max-repos|..." vs "max-pulls|..."), so it is the one
// member left off the barrel; importers use the module path for it. Everything else in
// the module is re-exported explicitly.
export { reportUnlabeled, REPORT_UNLABELED_SCHEMA } from "./verbs/report_unlabeled.ts";
export type { Target, State, ReportUnlabeledInput, UnlabeledItem, ReportUnlabeledResult } from "./verbs/report_unlabeled.ts";
