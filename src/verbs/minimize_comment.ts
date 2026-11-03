/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/minimize_comment.ts
 *	@Date: 2026-11-02T19:55:39-08:00 (1793678139)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T20:26:21-08:00 (1793679981)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";

/**
 * Custom verb: minimize_comment — hide a comment (collapse it, "Hide → Resolved" in the UI) or
 * show it again. Used to fold away bot review comments once they're addressed. Reversible.
 *
 * Upstream has no tool for it; it's the GraphQL `minimizeComment` / `unminimizeComment`
 * mutations, which take the comment's node id. A comment can be named by node id, or by its
 * REST id plus `type` (issue / PR conversation comment, or PR review comment), in which case
 * the node id is looked up first. Runs on the write PAT (Issues or Pull requests: write).
 */

export const MINIMIZE_CLASSIFIERS = ["RESOLVED", "OUTDATED", "DUPLICATE", "OFF_TOPIC", "SPAM", "ABUSE"] as const;
export type MinimizeClassifier = (typeof MINIMIZE_CLASSIFIERS)[number];

export interface MinimizeCommentInput {
	owner: string;
	repo?: string;
	/** Comment node id (e.g. "IC_…" or "PRRC_…"). */
	commentId?: string;
	/** REST comment id, with `type`, when the node id isn't at hand. Needs `repo`. */
	commentNumber?: number;
	type?: "issue" | "review";
	/** Why it's hidden. Default RESOLVED. */
	classifier?: MinimizeClassifier;
	/** true shows a hidden comment again. */
	unhide?: boolean;
}

export interface MinimizeCommentResult {
	commentId: string;
	isMinimized: boolean;
	minimizedReason: string | null;
}

const MINIMIZE = `
	mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
		minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
			minimizedComment { isMinimized minimizedReason }
		}
	}`;

const UNMINIMIZE = `
	mutation($id: ID!) {
		unminimizeComment(input: { subjectId: $id }) {
			unminimizedComment { isMinimized minimizedReason }
		}
	}`;

/** The node id the mutation needs, looked up from a REST id when that's what was given. */
async function nodeIdOf(octokit: Octokit, input: MinimizeCommentInput): Promise<string> {
	if (input.commentId !== undefined) {
		if (typeof input.commentId !== "string" || !input.commentId.trim()) throw new Error("minimize_comment: commentId must be a comment node id");
		if (input.commentNumber !== undefined) throw new Error("minimize_comment: pass commentId or commentNumber, not both");
		return input.commentId;
	}
	if (!Number.isSafeInteger(input.commentNumber) || (input.commentNumber as number) <= 0) {
		throw new Error("minimize_comment: pass commentId (node id), or commentNumber (REST id) with type and repo");
	}
	if (input.type !== "issue" && input.type !== "review") throw new Error('minimize_comment: commentNumber needs type "issue" (issue or PR conversation comment) or "review" (PR review comment)');
	if (typeof input.repo !== "string" || !input.repo) throw new Error("minimize_comment: commentNumber needs repo");
	const route = input.type === "issue" ? "GET /repos/{owner}/{repo}/issues/comments/{comment_id}" : "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}";
	const res = await octokit.request(route, { owner: input.owner, repo: input.repo, comment_id: input.commentNumber as number });
	const nodeId = (res.data as { node_id?: unknown }).node_id;
	if (typeof nodeId !== "string" || !nodeId) throw new Error(`minimize_comment: GitHub returned no node id for ${input.type} comment ${input.commentNumber}`);
	return nodeId;
}

export async function minimizeComment(octokit: Octokit, input: MinimizeCommentInput): Promise<MinimizeCommentResult> {
	const classifier = input.classifier ?? "RESOLVED";
	if (input.unhide === true && input.classifier !== undefined) throw new Error("minimize_comment: unhide takes no classifier");
	if (!MINIMIZE_CLASSIFIERS.includes(classifier)) throw new Error(`minimize_comment: classifier must be one of ${MINIMIZE_CLASSIFIERS.join(", ")}`);
	const id = await nodeIdOf(octokit, input);
	type Out = { isMinimized: boolean; minimizedReason: string | null };
	if (input.unhide === true) {
		const data = await octokit.graphql<{ unminimizeComment?: { unminimizedComment?: Out } }>(UNMINIMIZE, { id });
		const c = data.unminimizeComment?.unminimizedComment;
		if (!c) throw new Error(`minimize_comment: GitHub returned no comment for "${id}"`);
		return { commentId: id, isMinimized: c.isMinimized, minimizedReason: c.minimizedReason ?? null };
	}
	const data = await octokit.graphql<{ minimizeComment?: { minimizedComment?: Out } }>(MINIMIZE, { id, classifier });
	const c = data.minimizeComment?.minimizedComment;
	if (!c) throw new Error(`minimize_comment: GitHub returned no comment for "${id}"`);
	return { commentId: id, isMinimized: c.isMinimized, minimizedReason: c.minimizedReason ?? null };
}

export const MINIMIZE_COMMENT_DESCRIPTION =
	'Hide a comment on an issue or PR (collapsed, like "Hide → Resolved" in GitHub), or show it again with unhide: true. Meant for folding away bot review comments once they\'re addressed. Name the comment by node id (commentId, e.g. from pull_request_read get_review_comments), or by REST id (commentNumber) with type "issue" (issue or PR conversation comment) or "review" (PR review comment) and repo. Runs on the write PAT.';

export const MINIMIZE_COMMENT_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login); selects the write credential" },
		repo: { type: "string", description: "repository name (needed with commentNumber)" },
		commentId: { type: "string", description: 'comment node id, e.g. "IC_…" or "PRRC_…"' },
		commentNumber: { type: "number", description: "REST comment id, used with type and repo when the node id isn't at hand" },
		type: { type: "string", enum: ["issue", "review"], description: "with commentNumber: issue (issue or PR conversation comment) or review (PR review comment)" },
		classifier: { type: "string", enum: [...MINIMIZE_CLASSIFIERS], description: "why it's hidden (default RESOLVED)" },
		unhide: { type: "boolean", description: "true shows a hidden comment again" }
	}
};
