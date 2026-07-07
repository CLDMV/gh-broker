/**
 * Custom verb: link_issue — create an EXPLICIT PR→issue closing reference.
 *
 * Why this is a custom verb and not a proxied tool: the hosted MCP has no
 * PR→issue closing-link tool, and we deliberately do NOT depend on commit-message
 * keywords (the next→master squash can drop them, and merging to next closes
 * nothing). This calls the `addClosingIssueReference` GraphQL mutation directly.
 *
 * Caveat: `addClosingIssueReference` is a preview/feature-flagged mutation (not in
 * the public schema; `closingIssuesReferences` is read-only). It works today
 * (CLDMV CI uses it). If GitHub requires a preview header, set GH_BROKER_GRAPHQL_FEATURES
 * (comma-separated) — we don't hardcode a guessed flag name.
 */

const GRAPHQL = "https://api.github.com/graphql";

export interface LinkIssueInput {
	owner: string;
	repo: string;
	/** pull request number */
	pull: number;
	/** issue number to link as a closing reference */
	issue: number;
}

interface GraphQLResult<T> {
	data?: T;
	errors?: { message: string }[];
}

function headers(token: string): Record<string, string> {
	const h: Record<string, string> = {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"content-type": "application/json",
		"user-agent": "cldmv-gh-broker"
	};
	const features = process.env.GH_BROKER_GRAPHQL_FEATURES;
	if (features) h["graphql-features"] = features;
	return h;
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(GRAPHQL, { method: "POST", headers: headers(token), body: JSON.stringify({ query, variables }) });
	if (!res.ok) throw new Error(`graphql HTTP ${res.status} ${res.statusText}`);
	const body = (await res.json()) as GraphQLResult<T>;
	if (body.errors?.length) throw new Error(`graphql: ${body.errors.map((e) => e.message).join("; ")}`);
	if (!body.data) throw new Error("graphql: empty response");
	return body.data;
}

/** Resolve node IDs, then create the closing reference. Returns the linked issue's node id. */
export async function linkIssue(token: string, input: LinkIssueInput): Promise<{ pullRequestId: string; issueId: string }> {
	const ids = await gql<{
		repository: { pullRequest: { id: string } | null; issue: { id: string } | null };
	}>(
		token,
		`query($owner:String!,$repo:String!,$pr:Int!,$issue:Int!){
			repository(owner:$owner,name:$repo){
				pullRequest(number:$pr){ id }
				issue(number:$issue){ id }
			}
		}`,
		{ owner: input.owner, repo: input.repo, pr: input.pull, issue: input.issue }
	);
	const pullRequestId = ids.repository.pullRequest?.id;
	const issueId = ids.repository.issue?.id;
	if (!pullRequestId) throw new Error(`link_issue: PR #${input.pull} not found in ${input.owner}/${input.repo}`);
	if (!issueId) throw new Error(`link_issue: issue #${input.issue} not found in ${input.owner}/${input.repo}`);

	await gql<{ addClosingIssueReference: { clientMutationId: string | null } }>(
		token,
		`mutation($pr:ID!,$issue:ID!){
			addClosingIssueReference(input:{pullRequestId:$pr, issueId:$issue}){ clientMutationId }
		}`,
		{ pr: pullRequestId, issue: issueId }
	);
	return { pullRequestId, issueId };
}

/** JSON Schema advertised to the agent for this custom verb. */
export const LINK_ISSUE_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "pull", "issue"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login)" },
		repo: { type: "string", description: "repository name" },
		pull: { type: "integer", description: "pull request number" },
		issue: { type: "integer", description: "issue number to close when the PR merges to the default branch" }
	}
};
