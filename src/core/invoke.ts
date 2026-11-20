/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/invoke.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-19T16:59:24-08:00 (1795136364)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library's public entry (design #175 §2b): `invoke(name, args, ctx)` — one call in,
 * one JSON-safe result out. This is what Quack's GitHub driver calls, and what the
 * daemon's Router composes the pieces of (the Router keeps its own allowlist/gate/audit
 * wrapper over the same core; its output bytes are pinned unchanged).
 *
 * What invoke does, in the daemon's call order minus the daemon-only layers (no per-call
 * audit rows — those are the host's, §2c; no OTP gate class — the gate is the caller's
 * `ctx.approve` seam, round-3 M5): policy gate → availability → input validation → the
 * OTP approval → owner resolution → resolveToken → dispatch through the router core.
 *
 * The surface is pure library: no secrets, no filesystem, no sockets, no daemon imports,
 * no clock or randomness of its own (`ctx.now` is the caller's clock; nothing here reads
 * one yet — the report verbs' clock reads move in a later slice). Results are JSON-safe
 * and carry `mcpTarget` where the call forwarded; errors are typed `{ code, message }`
 * (InvokeError); invoke NEVER builds MCP content blocks — what it returns is the
 * dispatch's own result, and wrapping is the host's job.
 */

// Type-only: erased at runtime, so the daemon's host imports in config.ts (fs, the
// agents wiring) never enter the library's graph — ConfigLib is §2g's lib-config half.
import type { ConfigLib } from "./config.ts";
import { MANIFEST, strictPolicy, type PolicyApplication } from "./manifest.ts";
import { isEnabled, unavailableReason, type Capability } from "./availability.ts";
import { OTP_ARG, OTP_STATUS, isGated } from "./otp-policy.ts";
import {
	creationOwner,
	dispatchCall,
	extractOwner,
	indexTools,
	refuseLogDeletion,
	REPO_CREATING,
	type RouteDeps,
	type Upstream
} from "./router-core.ts";
import type { AuditSink, Mode, TokenResolver, ToolRule } from "./types.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The ghcr verbs are host-only: they run on the daemon's GhcrService, never in the library. */
const GHCR_TOOLS = new Set(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);

/**
 * invoke's typed error: `{ code, message }`, safe to return to an agent (no token, no
 * seed, no path ever enters a message — the same rule the gate's refusals follow).
 * Verb and upstream errors are NOT wrapped: they propagate as the core produced them,
 * with their own types and detail intact.
 */
export class InvokeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "InvokeError";
		this.code = code;
	}
}

/**
 * What one invoke call needs from its host (design #175 §2b). `approve` is REQUIRED
 * (round-3 M5) — every manifest-gated tool goes through it; a JS caller that omits it
 * still fails closed (the runtime check below), because a host that cannot elicit an
 * OTP must never run a gated write.
 */
export interface InvokeCtx {
	/** The person the call runs for — what the resolver and the approve seam see. */
	person: string;
	/** The only credential path (design #175 §2a). Per call, never cached; null = no access. */
	resolveToken: TokenResolver;
	/** The optional security-event sink (design #175 §2c). Per-call audit rows are the host's. */
	audit?: AuditSink;
	/** The call's cancellation signal. */
	signal: AbortSignal;
	/** The caller's clock, in ms. Nothing in the library reads a clock of its own. */
	now: number;
	/** Per-call timeout in ms, combined with `signal` (see invoke). Absent: no timeout. */
	timeoutMs?: number;
	/**
	 * The upstream (hosted-MCP) client. Absent: the library's per-call forwarder
	 * (perCallUpstream) when createBroker got an upstreamUrl; neither → forwarded tools
	 * fail closed. The daemon always injects its pooled implementation.
	 */
	upstream?: Upstream;
	/**
	 * The OTP elicitation seam (round-3 M5): called for every manifest-gated tool.
	 * Returns "ok", or a typed refusal — which invoke rethrows verbatim as its own
	 * typed error. Without it, a gated tool is refused (`otp-required`, fail closed).
	 */
	approve: (tool: string, person: string, args: unknown) => Promise<"ok" | { code: string; message: string }>;
}

/**
 * One invoke call's result: JSON-safe, `mcpTarget` audit-only (present exactly when the
 * call forwarded to the hosted MCP), and `result` the dispatch's own output — the local
 * verb's or the upstream's result object. invoke never wraps it into MCP content blocks.
 */
export interface JsonSafeResult {
	tool: string;
	/** The effective mode the call ran at. */
	mode: Mode;
	/** The upstream MCP tool the call became — audit-only, never a content block. */
	mcpTarget?: string;
	/** What the call produced. JSON-serializable; never token-shaped. */
	result: unknown;
}

/** The bound entry: the (name, args, ctx) signature the note fixes. */
export interface InvokeFn {
	(name: string, args: unknown, ctx: InvokeCtx): Promise<JsonSafeResult>;
}

/**
 * A driver call's declared request (design #175 §2b, the rummage run shape): what the
 * manifest declared for this tool — the hosted-MCP request for a forward, or the
 * execution op for a local verb. `run` validates the shape and delegates to invoke;
 * everything else (policy, approve, tokens, dispatch) is the same code path.
 */
export type DriverRequest =
	| { op: "mcp"; target: string }
	| { op: "graphql" | "rest"; tool: string };

/** run returns exactly what invoke returns — the adapter adds no shape of its own. */
export type DriverResult = JsonSafeResult;

/** The bound adapter: the (request, args, ctx) signature the note fixes. */
export interface RunFn {
	(request: DriverRequest, args: unknown, ctx: InvokeCtx): Promise<DriverResult>;
}

/** The tool a declared request names. Thin validation only — invoke owns every policy. */
function toolOfRequest(request: DriverRequest): string {
	if (typeof request !== "object" || request === null) throw new InvokeError("bad-request", "the driver request must be an object");
	if (request.op === "mcp") {
		if (typeof request.target !== "string" || !request.target) throw new InvokeError("bad-request", 'a driver request with op "mcp" names its upstream tool in "target"');
		return request.target;
	}
	if (request.op === "graphql" || request.op === "rest") {
		if (typeof request.tool !== "string" || !request.tool) throw new InvokeError("bad-request", `a driver request with op "${request.op}" names its verb in "tool"`);
		return request.tool;
	}
	throw new InvokeError("bad-request", `unsupported driver op "${String((request as { op?: unknown }).op)}" — expected "mcp", "graphql" or "rest"`);
}

/**
 * The library's own per-call Upstream (design #175 §2a): a fresh MCP client connection
 * per forward — no token-keyed cache, and nothing token-shaped outlives the call. The
 * daemon injects its pooled UpstreamPool instead. `upstreamUrl` is the hosted MCP base
 * URL, supplied by the host (the lib-config half carries no upstream field by design).
 */
export function perCallUpstream(url: string, clientInfo = { name: "cldmv-gh-broker", version: "0.0.0" }): Upstream {
	return {
		async forward(tool, args, token, signal, timeoutMs) {
			const client = new Client(clientInfo);
			const transport = new StreamableHTTPClientTransport(new URL(url), {
				// The SDK's StreamableHTTPClientTransport overwrites requestInit.signal with
				// its own abort controller — the call's signal bounds the HANDSHAKE instead,
				// via connect's options (design #175 §2b).
				requestInit: { headers: { Authorization: `Bearer ${token}` } }
			});
			try {
				await client.connect(transport, signal ? { signal } : undefined);
				// timeoutMs in the request options so the SDK's own 60 s default can't cap a
				// longer caller timeout; the signal (which carries AbortSignal.timeout when
				// timeoutMs was set) still aborts whichever fires first.
				const requestOptions = signal || timeoutMs !== undefined
					? { ...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}) }
					: undefined;
				// Without a signal or a timeout this is today's exact two-argument call.
				return (await (requestOptions !== undefined
					? client.callTool({ name: tool, arguments: args }, undefined, requestOptions)
					: client.callTool({ name: tool, arguments: args }))) as CallToolResult;
			} finally {
				// The connection is per call: closed whatever the outcome, never cached.
				await client.close().catch(() => {});
			}
		}
	};
}

/** createBroker's options. The policy defaults to strict (the library default, §2h). */
export interface BrokerOptions {
	/**
	 * The tool policy a host serves under: strict (the default — the manifest is the
	 * universe, modes clamp, OTP is add-only) or the daemon's permissive one. Takes the
	 * config's rules, returns the effective ones.
	 */
	policy?: (rules: readonly ToolRule[]) => PolicyApplication;
	/**
	 * The host's availability facts (design §2a). Absent: invoke checks only the
	 * structural facts a dispatch would crash on (npm_scaffold needs config.npm); a host
	 * that advertises tools it cannot serve applies its own availability policy first.
	 */
	capability?: Capability;
	/**
	 * The hosted MCP base URL for the library's per-call forwarder, used when a call's
	 * ctx carries no upstream. Absent: forwarded tools fail closed without ctx.upstream.
	 */
	upstreamUrl?: string;
	/**
	 * The host's package version, reported in the per-call forwarder's MCP handshake.
	 * A host that doesn't pass one reports 0.0.0 (the daemon never uses this path — its
	 * pooled Upstream identifies itself in src/upstream.ts).
	 */
	clientVersion?: string;
}

/**
 * Build the library entry for one host. The rules come from the host's config under its
 * chosen policy — module state is forbidden (the library's purity rules), so the entry
 * is bound per host here; the returned `invoke` carries the (name, args, ctx) signature
 * the design fixes, and `run` the (request, args, ctx) driver adapter over it.
 */
export function createBroker(config: ConfigLib, opts: BrokerOptions = {}): { invoke: InvokeFn; run: RunFn } {
	const { tools } = (opts.policy ?? strictPolicy)(config.tools);
	const rules = indexTools(tools);
	// The per-call forwarder's handshake identity carries the host's version (BrokerOptions
	// .clientVersion) — a library cannot import the root package.json without leaving
	// src/core/ (the boundary guard); a host that doesn't pass one reports 0.0.0.
	const libraryUpstream = opts.upstreamUrl
		? perCallUpstream(opts.upstreamUrl, { name: "cldmv-gh-broker", version: opts.clientVersion ?? "0.0.0" })
		: undefined;

	const invoke: InvokeFn = async (name, args, ctx) => {
		// The policy gate: an unknown tool is refused, a disabled one too.
		const rule = rules.get(name);
		if (!rule) throw new InvokeError("unknown-tool", `tool "${name}" is not allowed`);
		if (!isEnabled(rule)) throw new InvokeError("disabled", `tool "${name}" is disabled; a host serves it by enabling it on the tool's rule`);
		const unavailable = availabilityProblem(config, opts.capability, name, rule);
		if (unavailable) throw new InvokeError("unavailable", `tool "${name}" is not available on this broker: ${unavailable}`);
		// otp_status is the daemon gate's status read; ghcr verbs run on the daemon's
		// GhcrService. Neither is dispatchable from the library — fail closed, named.
		if (name === OTP_STATUS) throw new InvokeError("not-supported", `tool "${name}" is the daemon's OTP gate status; a library host serves its own`);
		if (GHCR_TOOLS.has(name)) throw new InvokeError("not-supported", `tool "${name}" runs on the daemon host's GHCR service; a library host cannot dispatch it`);
		let callArgs = (args ?? {}) as Record<string, unknown>;
		// Input validation before the approval, so a call that can't run never spends a
		// code (the daemon's order — the creationOwner check is input validation, not a
		// protected-write event, and runs before the gate).
		let createdIn: string | undefined;
		if (REPO_CREATING.has(name) || name === "actions_run_trigger") {
			if (name === "actions_run_trigger") refuseLogDeletion(callArgs);
			else createdIn = creationOwner(name, callArgs, config.owners);
		}
		// The OTP approval seam (round-3 M5): every manifest-gated tool goes through it,
		// with the raw args (the code rides in them until this point).
		if (isGated(rule)) {
			if (typeof ctx.approve !== "function") {
				// JS callers can omit the required seam; fail closed — no OTP, no gated call.
				throw new InvokeError("otp-required", `tool "${name}" needs a one-time password, but this host provides no OTP approval (ctx.approve) — nothing was run`);
			}
			const verdict = await ctx.approve(name, ctx.person, callArgs);
			if (verdict !== "ok") {
				// The approval refused the call: the typed refusal passes through verbatim,
				// and the security sink (if wired) sees the refused OTP check. invoke does
				// not count failures — the approve implementation owns its counter.
				ctx.audit?.security({ kind: "code-bad", tool: name, person: ctx.person, failures: 0 });
				throw new InvokeError(verdict.code, verdict.message);
			}
		}
		// `otp` is the gate's own argument: approve has seen it, it never reaches a verb
		// or the upstream (the daemon strips it the same way).
		if (Object.hasOwn(callArgs, OTP_ARG)) {
			const { [OTP_ARG]: _code, ...rest } = callArgs;
			callArgs = rest;
		}
		// Owner resolution — the daemon's exact shape: an owner named in the args, the
		// creation org for repo-creating tools, or the configured defaultOwner's READ
		// fallback for owner-less reads. Writes never fall back.
		let owner = createdIn ?? extractOwner(callArgs);
		if (!owner && rule.mode === "read" && config.defaultOwner && Object.hasOwn(config.owners, config.defaultOwner)) {
			owner = config.defaultOwner.toLowerCase();
		}
		if (!owner) throw new InvokeError("no-owner", `tool "${name}": could not determine repo owner from arguments`);
		const token = await ctx.resolveToken({ person: ctx.person, owner, mode: rule.mode, kind: "github" });
		if (token === null) throw new InvokeError("no-access", `no credentials configured for owner "${owner}" — add it to config.owners + creds`);
		// A local verb needs no upstream (its best-effort sub-calls tolerate a missing one);
		// a forwarded call fails closed without one.
		const upstream = ctx.upstream ?? libraryUpstream;
		if (!upstream && !rule.custom) throw new InvokeError("no-upstream", `tool "${name}" forwards to the hosted MCP, but this host provides no upstream client (ctx.upstream)`);
		// The call's signal (design #175 §2b): the ctx signal, or the ctx signal combined
		// with the caller's timeoutMs via AbortSignal.any — reaching Octokit as
		// request.signal and the MCP transport as its signal. The timer exists only when a
		// timeout was asked for.
		const signal = ctx.timeoutMs !== undefined ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : ctx.signal;
		const deps: RouteDeps = {
			resolveToken: ctx.resolveToken,
			// A custom verb without an upstream still dispatches — its one upstream sub-call
			// (report_ci_status's log fetch) is best-effort and tolerates the failure.
			upstream: upstream ?? { forward: async () => { throw new InvokeError("no-upstream", "this host provides no upstream client (ctx.upstream)"); } },
			signal,
			...(config.npm ? { npm: config.npm } : {})
		};
		const result = await dispatchCall(deps, rule, name, callArgs, owner, token, ctx.person);
		// mcpTarget, where the verb yields one: the manifest's declared request target for
		// a forwarded call, the tool name for a config-only forward, nothing for a local verb.
		const decl = Object.hasOwn(MANIFEST, name) ? MANIFEST[name] : undefined;
		const mcpTarget = rule.custom ? undefined : decl?.kind === "forwarded" ? decl.request.target : name;
		return { tool: name, mode: rule.mode, ...(mcpTarget !== undefined ? { mcpTarget } : {}), result };
	};

	// The rummage-shaped driver adapter (design #175 §2b): same code path, thin shape
	// validation in front.
	const run: RunFn = async (request, args, ctx) => invoke(toolOfRequest(request), args, ctx);

	return { invoke, run };
}

/**
 * The availability facts invoke can check. With a Capability, the host's own predicate
 * answers (the daemon's exact check); without one, only the structural facts a dispatch
 * would crash on — npm_scaffold needs config.npm, which availability would have caught
 * on the daemon before the tool was ever served.
 */
function availabilityProblem(config: ConfigLib, capability: Capability | undefined, name: string, rule: ToolRule): string | undefined {
	if (capability) return unavailableReason(rule, config, capability);
	if (name === "npm_scaffold" && !config.npm) return "the npm integration is not configured (enable it with the installer's --npm)";
	return undefined;
}
