# Using gh-broker as a library

Since v0.12.0 the package exports the broker's core as a library, at `@cldmv/gh-broker` and `@cldmv/gh-broker/core` (both resolve to the same module). A host other than the daemon uses it to serve the same tools with the same policy, OTP checks and dispatch code, while keeping its own credentials, OTP flow and audit log.

The library is pure: it has no secrets, filesystem, sockets or clock of its own. The daemon (`gh-broker` and the systemd unit) is not part of the export. Run it through the command, not by importing the package.

## What the host provides

| Host concern                            | How it reaches the library                               |
| --------------------------------------- | -------------------------------------------------------- |
| Which tools exist, owners, npm settings | The config's library half, validated by `parseConfigLib` |
| Tokens                                  | `ctx.resolveToken`, called per call, never cached        |
| OTP for gated tools                     | `ctx.approve`, required                                  |
| Cancellation and timeouts               | `ctx.signal`, optional `ctx.timeoutMs`                   |
| The hosted MCP client                   | `ctx.upstream`, or `upstreamUrl` on `createBroker`       |
| Security events                         | optional `ctx.audit`                                     |
| Per-call audit rows, MCP content blocks | the host, from what `invoke` returns                     |

## A minimal host

```ts
import { createBroker, parseConfigLib, InvokeError } from "@cldmv/gh-broker";

const config = parseConfigLib({
	tools: [
		{ name: "pull_request_read", mode: "read", augment: true },
		{ name: "report_ci_status", mode: "read", custom: true },
		{ name: "issue_write", mode: "write" }
	],
	// The values are credential references the host's own resolver understands.
	owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } }
});

const broker = createBroker(config, {
	upstreamUrl: "https://api.githubcopilot.com/mcp/x/all",
	clientVersion: "1.0.0"
});

try {
	const out = await broker.invoke(
		"pull_request_read",
		{ method: "get", owner: "CLDMV", repo: "gh-broker", pullNumber: 219 },
		{
			person: "alice",
			resolveToken: async ({ person, owner, mode, kind }) => lookUpToken(person, owner, mode, kind), // string, or null for no access
			approve: async (tool, person, args) => checkOtp(tool, person, args), // "ok", or { code, message, badCode? }
			signal: AbortSignal.timeout(30_000),
			now: Date.now(),
			timeoutMs: 20_000
		}
	);
	console.log(out.result);
} catch (err) {
	if (err instanceof InvokeError) console.error(err.code, err.message);
	else throw err;
}
```

`lookUpToken` and `checkOtp` are the host's. `parseConfigLib` reports errors as `config.<field>: …`, the same messages the daemon prints for its `config.json`.

## `createBroker(config, options)`

Builds the entry for one host and returns `{ invoke, run }`. Options:

- `policy`: how config applies over the built-in manifest (`MANIFEST`). The default is `strictPolicy`: only tools the manifest declares exist, a config rule can't widen a tool's mode, it can add an OTP requirement but never remove one, and tools the manifest marks off by default (the Copilot assignment tools, and the host-only `otp_status` and `ghcr_*`) stay off until their rule sets `enabled: true`. The manifest declares the local verbs and a set of forwarded tools (`pull_request_read`, `list_pull_requests`, `issue_write`, `merge_pull_request`, `pull_request_review_write`, `create_repository`, …); a plain forward such as `issue_read` that the daemon serves from `config.json` alone doesn't exist under it. `permissivePolicy` is what the daemon uses: `config.json` stays authoritative, tools missing from the manifest are forwarded as configured, and widening a manifest tool only logs a warning (returned in the policy's `warnings`).
- `capability`: the host's availability check (`{ has(ref), otpProblem() }`), used to refuse tools whose credentials or setup are missing. Without it, the library only checks that `npm_scaffold` has `config.npm`.
- `upstreamUrl`: the hosted MCP URL for the built-in forwarder, used when a call has no `ctx.upstream`. With neither, forwarded tools fail with `no-upstream`; local verbs still run.
- `clientVersion`: the version the forwarder reports in its MCP handshake. Default `0.0.0`.

## `invoke(name, args, ctx)`

Runs one call, in this order: policy, availability, input validation, owner resolution, the upstream check, OTP approval, token resolution, dispatch. Everything that can refuse a call runs before `approve`, so a call that can't run never uses up a code.

`ctx`:

- `person`: who the call runs for. The resolver and `approve` receive it.
- `resolveToken({ person, owner, mode, kind, signal })`: returns a token or `null`. `kind` is `"github"`, `"ghcr"` or `"npm"`. Nothing token-shaped ever appears in a result or an error.
- `approve(tool, person, args, signal)`: called for every gated tool (under the strict policy: `delete_branch`, `dismiss_alert`, `create_repository`, `fork_repository`, `merge_pull_request`, `pull_request_review_write`, `actions_run_trigger`, `label_write` and the Copilot assignment tools, plus any tool whose rule sets `otp: true`), with the raw arguments (the code is in `args.otp`). Return `"ok"`, or `{ code, message }`, which `invoke` throws as an `InvokeError` with that code. Set `badCode: true` on a refusal for a wrong code so `ctx.audit` gets a `code-bad` event. The library keeps no failure count; lockouts are the host's. The `otp` argument is stripped before dispatch.
- `signal`, `timeoutMs`: both reach the approve hook, the resolver, Octokit, the MCP transport and npm registry requests. A `timeoutMs` that isn't a positive number fails with `bad-args`.
- `now`: the caller's clock, in ms.
- `upstream`, `audit`: optional, as above.

The result is `{ tool, mode, mcpTarget?, result }`. `result` is the verb's or the upstream's own output, JSON-safe. `mcpTarget` is set when the call was forwarded to the hosted MCP. `invoke` builds no MCP content blocks.

Owners resolve the way the daemon does: the owner named in the arguments, the target org for repo-creating tools, or `defaultOwner` for reads that name none. Writes never fall back to `defaultOwner`.

## `run(request, args, ctx)`

A thin adapter for hosts that dispatch by declared request. `request` is `{ op: "mcp", target }` for a tool forwarded to the hosted MCP, or `{ op: "graphql" | "rest", tool }` for a local verb. The `op` has to match what the manifest says the tool is, and then the call goes through `invoke` unchanged.

## Errors

`InvokeError` has a `code` and a message that never contains a token, seed or path:

| Code            | Meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `unknown-tool`  | not in the effective tool list                                              |
| `disabled`      | the tool's rule has `enabled: false`                                        |
| `unavailable`   | the host's availability check refused it                                    |
| `not-supported` | host-only tool: `otp_status`, `ghcr_push`, `ghcr_push_status`, `ghcr_tags`  |
| `bad-args`      | invalid arguments or `timeoutMs`, or a `run` op that doesn't match the tool |
| `bad-request`   | a malformed `run` request                                                   |
| `no-owner`      | no owner could be worked out from the arguments                             |
| `no-upstream`   | a forwarded tool with no upstream client                                    |
| `otp-required`  | a gated tool and no `ctx.approve`                                           |
| `otp-refused`   | `approve` returned something that isn't a valid verdict                     |
| `no-access`     | the resolver returned `null`                                                |

A refusal from `approve` uses the code the host returned. Errors from a verb or from GitHub are not wrapped and pass through as they are.

## Other exports

The barrel also exports the manifest (`MANIFEST`) and both policies, the catalog helpers, `perCallUpstream(url)` (a hosted-MCP forwarder that opens a fresh connection per call), the shared types (`ToolRule`, `TokenResolver`, `AuditSink`, …) and the pure verbs with their input schemas. `report_unlabeled`'s `TruncatedReason` type is the one name left off the barrel because it clashes with `report_ci_status`'s; import it from the verb's module path if you need it.

Tool arguments and results are the same as the daemon's; see [TOOLS.md](TOOLS.md).
