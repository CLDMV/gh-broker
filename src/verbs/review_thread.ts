import type { Octokit } from "@octokit/core";

/**
 * Custom verbs: reply_review_thread + resolve_review_thread — respond to and resolve
 * pull-request review threads (e.g. Copilot's review comments).
 *
 * Why custom verbs:
 *  - The hosted GitHub MCP can READ review threads (`pull_request_read` →
 *    `get_review_comments`, which returns each thread's node id + `isResolved`), but
 *    exposes NO tool to reply inside a thread or to resolve/unresolve one. Those are
 *    GraphQL mutations (`addPullRequestReviewThreadReply`, `resolveReviewThread`,
 *    `unresolveReviewThread`) with no hosted-MCP wrapper, so they can't be proxied.
 *  - Unlike `link_issue`'s App-token-only mutation, these ARE available to a
 *    fine-grained PAT with **Pull requests: write** — the same permission the broker's
 *    write cred already uses for `create_pull_request` / `update_pull_request` /
 *    `add_issue_comment`. So they run on the resolved write PAT (least privilege), not
 *    the App token.
 *
 * Uses Octokit (`octokit.graphql`) — GitHub's official SDK.
 *
 * The `threadId` is the review-thread NODE id (e.g. "PRRT_kwDO…"), taken verbatim from
 * `pull_request_read` (`get_review_comments`) — each returned thread carries it as `id`.
 */

export interface ResolveReviewThreadInput {
	owner: string;
	repo?: string;
	/** Review-thread node id (e.g. "PRRT_…") from pull_request_read get_review_comments. */
	threadId: string;
	/** true → resolve (default); false → unresolve. */
	resolve?: boolean;
}

export interface ReplyReviewThreadInput {
	owner: string;
	repo?: string;
	/** Review-thread node id (e.g. "PRRT_…") to reply into. */
	threadId: string;
	/** Reply body (Markdown). */
	body: string;
}

const RESOLVE_THREAD = `
	mutation($threadId: ID!) {
		resolveReviewThread(input: { threadId: $threadId }) {
			thread { id isResolved }
		}
	}`;

const UNRESOLVE_THREAD = `
	mutation($threadId: ID!) {
		unresolveReviewThread(input: { threadId: $threadId }) {
			thread { id isResolved }
		}
	}`;

const REPLY_THREAD = `
	mutation($threadId: ID!, $body: String!) {
		addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
			comment { id url }
		}
	}`;

/** Resolve (or unresolve) a review thread. Returns the thread id and its new resolved state. */
export async function resolveReviewThread(
	octokit: Octokit,
	input: ResolveReviewThreadInput
): Promise<{ threadId: string; isResolved: boolean }> {
	const unresolve = input.resolve === false;
	const data = await octokit.graphql<{
		resolveReviewThread?: { thread: { id: string; isResolved: boolean } };
		unresolveReviewThread?: { thread: { id: string; isResolved: boolean } };
	}>(unresolve ? UNRESOLVE_THREAD : RESOLVE_THREAD, { threadId: input.threadId });
	const thread = (data.resolveReviewThread ?? data.unresolveReviewThread)?.thread;
	if (!thread) throw new Error(`resolve_review_thread: no thread returned for "${input.threadId}"`);
	return { threadId: thread.id, isResolved: thread.isResolved };
}

/** Post a reply inside a review thread. Returns the new comment's node id + html url. */
export async function replyReviewThread(
	octokit: Octokit,
	input: ReplyReviewThreadInput
): Promise<{ commentId: string; url: string }> {
	if (!input.body || !input.body.trim()) throw new Error("reply_review_thread: body is required");
	const data = await octokit.graphql<{
		addPullRequestReviewThreadReply: { comment: { id: string; url: string } };
	}>(REPLY_THREAD, { threadId: input.threadId, body: input.body });
	const comment = data.addPullRequestReviewThreadReply?.comment;
	if (!comment) throw new Error(`reply_review_thread: reply failed for "${input.threadId}"`);
	return { commentId: comment.id, url: comment.url };
}

/** JSON Schema advertised to the agent for resolve_review_thread. */
export const RESOLVE_REVIEW_THREAD_SCHEMA = {
	type: "object" as const,
	required: ["owner", "threadId"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the write credential" },
		repo: { type: "string", description: "repository name (optional; for the audit log only)" },
		threadId: {
			type: "string",
			description: 'review-thread node id (e.g. "PRRT_…"), taken verbatim from pull_request_read get_review_comments'
		},
		resolve: { type: "boolean", description: "true to resolve (default), false to unresolve", default: true }
	}
};

/** JSON Schema advertised to the agent for reply_review_thread. */
export const REPLY_REVIEW_THREAD_SCHEMA = {
	type: "object" as const,
	required: ["owner", "threadId", "body"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the write credential" },
		repo: { type: "string", description: "repository name (optional; for the audit log only)" },
		threadId: {
			type: "string",
			description: 'review-thread node id (e.g. "PRRT_…") to reply into, from pull_request_read get_review_comments'
		},
		body: { type: "string", description: "reply body (Markdown)" }
	}
};
