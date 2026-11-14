/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/router.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T11:38:43-08:00 (1794685123)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Caller, Config, OtpAudit, OtpGate, OtpRefusal, SecretStore, TokenResolver, ToolRule } from "./types.ts";
import type { AppAuth } from "./appauth.ts";
import { indexTools } from "./config.ts";
import { audit } from "./audit.ts";
import { unavailableReason } from "./availability.ts";
import { otpSetupProblem } from "./otp/policy.ts";
import { permissivePolicy } from "./manifest.ts";
import { GhcrService } from "./verbs/ghcr_push.ts";
// The Router consumes the OtpGate SEAM (src/types.ts, design #175 §2e); the daemon's
// concrete gate is imported only for the constructor default below — a host passes its
// own implementation through the optional parameter.
import { OtpGate as DaemonOtpGate } from "./otp/gate.ts";
import { OTP_ARG, OTP_STATUS, isGated } from "./otp/policy.ts";
// The dispatch layer (custom verbs, augmented forwards) is the library-facing router
// core (src/router-core.ts, design #175 §1's split row); this wrapper owns the
// allowlist, the gate, owner resolution and every audit row, and calls the core.
import { dispatchAugmented, dispatchCustom, type GhcrVerbs, type RouteDeps, type Upstream } from "./router-core.ts";

// The interface moved to the library-facing seams module (src/router-core.ts); re-exported
// so the old import path keeps working.
export type { Upstream } from "./router-core.ts";

const GHCR_TOOLS = new Set(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);

/**
 * The daemon host's {@link TokenResolver} (design #175 §2a) — the owner+mode→PAT lookup
 * over `config.owners` + the {@link SecretStore}. This is the only credential path the
 * routing logic sees: the routing code never reads the store or `config.owners` for a
 * token, it asks here, honoring the owner and the EFFECTIVE mode it was handed (a
 * host-narrowed mode is what gets requested). Per call, never cached; `null` means no
 * access and the caller turns it into the typed no-access error (fail closed).
 *
 * The `person` is irrelevant to owner resolution (the catalog's schema fetch passes
 * NO_PERSON for it) and is ignored here. `kind: "npm"` is not per-owner and not
 * mode-scoped — one granular token. `kind: "ghcr"` has no router path yet (the ghcr
 * verbs run on GhcrService's own store, host-side) and fails closed.
 */
export function hostTokenResolver(config: Config, secrets: SecretStore): TokenResolver {
	return async ({ owner, mode, kind }) => {
		if (kind === "npm") return config.npm ? secrets.resolve(config.npm.token) : null;
		if (kind === "ghcr") return null;
		// Object.hasOwn: "constructor"/"toString" must hit the prototype, not resolve a token.
		const creds = owner && Object.hasOwn(config.owners, owner) ? config.owners[owner] : undefined;
		if (!creds) return null;
		return secrets.resolve(mode === "write" ? creds.write : creds.read);
	};
}

/**
 * Enforces the default-deny allowlist, resolves the (owner, mode) → PAT, and either
 * forwards to the hosted MCP or dispatches a custom verb. The token never leaves here.
 */
export class Router {
	private readonly config: Config;
	private readonly secrets: SecretStore;
	private readonly upstream: Upstream;
	private readonly appAuth?: AppAuth;
	private readonly rules: Map<string, ToolRule>;
	/** The daemon host's resolver (design §2a): the only credential path the routing asks. */
	private readonly resolveToken: TokenResolver;
	/** What the dispatch layer (src/router-core.ts) runs with — fixed for the Router's lifetime. */
	private readonly routeDeps: RouteDeps;
	/** GHCR verbs run on config.ghcr's own credential, not the owner's GitHub PAT — the injected GhcrVerbs seam. */
	private ghcr?: GhcrVerbs;
	/** The OTP gate (#143), the injected OtpGate seam. Inert without config.otp. */
	private readonly otp: OtpGate;

	/**
	 * The constructor keeps its call shape (`new Router(config, secrets, upstream[, appAuth, gate[, ghcr]])`).
	 * `gate` is the OtpGate SEAM (src/types.ts, design #175 §2e) and `ghcr` the GhcrVerbs
	 * SEAM (src/router-core.ts, §2f) — the daemon composition (src/index.ts) constructs
	 * both and passes them. The defaults still construct the daemon's own gate and ghcr
	 * service: the suite's 58 test call sites rely on them, and a default of "must pass
	 * one" would be a test-visible change. Any implementation of either seam is accepted
	 * either way — the seam, not the class, is the contract.
	 */
	constructor(config: Config, secrets: SecretStore, upstream: Upstream, appAuth?: AppAuth, otp?: OtpGate, ghcr?: GhcrVerbs, resolveToken?: TokenResolver) {
		this.config = config;
		this.secrets = secrets;
		this.upstream = upstream;
		this.appAuth = appAuth;
		// The effective rules (design #175 §2h): the daemon serves the permissive policy
		// explicitly — config.json keeps today's authority, so the effective mode equals
		// the config's mode today. Routing asks the resolver for the rule's EFFECTIVE
		// mode, so a host-narrowed mode is what the credential lookup honors.
		this.rules = indexTools(permissivePolicy(config.tools).tools);
		// The 7th parameter lets a host (or a test spy) supply the resolver — the daemon
		// omits it and gets hostTokenResolver. Additive; no existing call site changes.
		this.resolveToken = resolveToken ?? hostTokenResolver(config, secrets);
		this.routeDeps = { resolveToken: this.resolveToken, upstream, ...(config.npm ? { npm: config.npm } : {}) };
		this.otp = otp ?? new DaemonOtpGate(config, secrets);
		this.ghcr = ghcr;
	}

	/**
	 * The daemon's availability facts (design §2a's capability predicate): ref presence
	 * over the store, plus the OTP setup check (which decodes the stored seed, so it
	 * stays a host-side function over the store).
	 */
	private readonly unavailable = (rule: ToolRule): string | undefined =>
		unavailableReason(
			rule,
			this.config,
			(ref) => this.secrets.has(ref),
			(config) => otpSetupProblem(config, this.secrets)
		);

	/** Tools advertised to the agent (used to build tools/list). */
	advertisedTools(): ToolRule[] {
		return this.config.tools.filter((rule) => !this.unavailable(rule));
	}

	/** Run `tool` for `caller`, the agent user whose socket the call came in on. */
	async call(tool: string, rawArgs: Record<string, unknown>, caller: Caller): Promise<CallToolResult> {
		const user = caller.user;
		const rule = this.rules.get(tool);
		if (!rule) {
			audit({ tool, user, decision: "deny", detail: "not in allowlist" });
			throw new Error(`tool "${tool}" is not allowed`);
		}
		// The caller's OTP hard lock blocks every tool except otp_status, before anything else is looked at.
		if (tool !== OTP_STATUS) {
			const locked = this.otp.hardLockRefusal(user);
			if (locked) {
				audit({ tool, user, decision: "deny", detail: "otp hard lock", ...locked.audit });
				throw locked;
			}
		}
		// `otp` is the broker's own gate argument: it never reaches the upstream or a verb.
		let args = rawArgs;
		let code: unknown;
		if (Object.hasOwn(rawArgs, OTP_ARG)) {
			const { [OTP_ARG]: given, ...rest } = rawArgs;
			code = given;
			args = rest;
		}
		// An optional integration that isn't set up hides its tools: refuse them the same way.
		const unavailable = this.unavailable(rule);
		if (unavailable) {
			audit({ tool, user, decision: "deny", detail: `unavailable: ${unavailable}` });
			throw new Error(`tool "${tool}" is not available on this broker: ${unavailable}`);
		}
		// otp_status needs no owner and no PAT.
		if (tool === OTP_STATUS) {
			audit({ tool, user, mode: rule.mode, decision: "custom", ok: true });
			return { content: [{ type: "text", text: JSON.stringify(this.otp.status(user)) }] };
		}
		// Checked before the gate, so a call that can't run never asks for a code.
		let createdIn: string | undefined;
		if (REPO_CREATING.has(tool) || tool === "actions_run_trigger") {
			try {
				if (tool === "actions_run_trigger") refuseLogDeletion(args);
				else createdIn = creationOwner(tool, args, this.config.owners);
			} catch (err) {
				const requested = typeof args.organization === "string" ? args.organization : extractOwner(args);
				audit({ tool, user, mode: rule.mode, ...(requested ? { owner: requested.toLowerCase() } : {}), decision: "error", detail: (err as Error).message });
				throw err;
			}
		}
		let otp: OtpAudit | undefined;
		if (isGated(rule)) {
			try {
				otp = this.otp.authorize(tool, code, user);
			} catch (err) {
				audit({ tool, user, decision: "deny", detail: "otp", ...(err as OtpRefusal).audit });
				throw err;
			}
		}
		// The GHCR verbs authenticate with config.ghcr's own credential, never an owner's GitHub
		// PAT, so they don't need (or touch) a config.owners entry.
		if (GHCR_TOOLS.has(tool)) return this.callGhcr(tool, args, rule, user, otp);
		// Owner-less reads (global advisory DB, get_me, notifications) fall back to
		// the configured defaultOwner's READ PAT. Writes never fall back — a write
		// must always name the owner it targets. The config.owners read here is the
		// ROUTING presence check (is defaultOwner configured at all), not a credential
		// read: an unconfigured defaultOwner must fall through to "no owner in args",
		// exactly as before — the token itself still comes only from the resolver.
		let owner = createdIn ?? extractOwner(args);
		if (!owner && rule.mode === "read" && this.config.defaultOwner && Object.hasOwn(this.config.owners, this.config.defaultOwner)) {
			owner = this.config.defaultOwner.toLowerCase();
		}
		if (!owner) {
			audit({ tool, user, decision: "error", detail: "no owner in args" });
			throw new Error(`tool "${tool}": could not determine repo owner from arguments`);
		}
		// The token comes from the resolver (design §2a) — the owner+mode→PAT lookup lives
		// there, not here. null (unconfigured owner) is the typed no-access refusal below.
		const token = await this.resolveToken({ person: user, owner, mode: rule.mode, kind: "github" });
		if (token === null) {
			audit({ tool, user, owner, decision: "error", detail: "no creds for owner" });
			throw new Error(`no credentials configured for owner "${owner}" — add it to config.owners + creds`);
		}
		const repoName = tool === "create_repository" ? args.name : args.repo;
		const repo = typeof repoName === "string" ? `${owner}/${repoName}` : owner;
		// A fork's audit line also names what was forked; owner/repo above are the new copy.
		const forked = tool === "fork_repository" ? { source: `${String(args.owner)}/${String(args.repo)}` } : {};

		const decision = rule.custom ? "custom" : rule.augment ? "augment" : "forward";
		try {
			const out = rule.custom
				? await dispatchCustom(this.routeDeps, tool, args, owner, token, user)
				: rule.augment
					? await dispatchAugmented(this.routeDeps, tool, args, owner, token)
					: await this.upstream.forward(tool, args, token);
			audit({ tool, user, owner, mode: rule.mode, repo, ...forked, decision, ok: true, ...otp });
			return out;
		} catch (err) {
			audit({ tool, user, owner, mode: rule.mode, repo, ...forked, decision, ok: false, detail: (err as Error).message, ...otp });
			throw err;
		}
	}

	/** GHCR verbs: config.ghcr checks the owner and image itself; no GitHub PAT is resolved. */
	private async callGhcr(tool: string, args: Record<string, unknown>, rule: ToolRule, user: string, otp: OtpAudit | undefined): Promise<CallToolResult> {
		const owner = extractOwner(args) ?? "";
		const repo = typeof args.image === "string" ? `${owner}/${args.image}` : owner;
		try {
			this.ghcr ??= new GhcrService(this.config.ghcr, this.secrets);
			const out = tool === "ghcr_push" ? await this.ghcr.push(args) : tool === "ghcr_tags" ? await this.ghcr.tags(args) : this.ghcr.status(args);
			audit({ tool, user, owner, mode: rule.mode, repo, decision: "custom", ok: true, ...otp });
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		} catch (err) {
			audit({ tool, user, owner, mode: rule.mode, repo, decision: "custom", ok: false, detail: (err as Error).message, ...otp });
			throw err;
		}
	}
}

/** Tools that create a repo, whose PAT is picked by the org the repo lands in. */
const REPO_CREATING = new Set(["create_repository", "fork_repository"]);

/**
 * The org a new repo lands in. Upstream creates it in the PAT user's own account when
 * `organization` is left out, so it's required here, and it must be a configured owner. Repos
 * are only created in orgs: upstream sends a configured user-owner's name to the org endpoint,
 * which 404s. For a fork, `owner` is the repo being forked and `organization` is where the
 * fork goes, so the write PAT is the destination's. create_repository also needs `private`
 * said explicitly, so a repo's visibility is never left to a default.
 */
export function creationOwner(tool: string, args: Record<string, unknown>, owners: Config["owners"]): string {
	if (typeof args.organization !== "string" || !args.organization) {
		throw new Error(`tool "${tool}": "organization" is required (the org the repo is created in); gh-broker doesn't create repos in a personal account`);
	}
	const org = args.organization.toLowerCase();
	if (!Object.hasOwn(owners, org)) throw new Error(`no credentials configured for owner "${org}" — add it to config.owners + creds`);
	if (tool === "create_repository" && typeof args.private !== "boolean") {
		throw new Error('tool "create_repository": "private" is required, true or false; a repo\'s visibility is never left to a default');
	}
	return org;
}

/**
 * actions_run_trigger's delete_workflow_run_logs method removes a run's logs, which are the
 * record of what a run did. The other methods (dispatch, re-run, cancel) stay, behind the gate.
 */
export function refuseLogDeletion(args: Record<string, unknown>): void {
	if (args.method === "delete_workflow_run_logs") throw new Error('tool "actions_run_trigger": method "delete_workflow_run_logs" is not allowed in gh-broker; a run\'s logs are kept');
}

/** Derive the repo owner from a tool call's arguments, so we pick the right PAT. */
export function extractOwner(args: Record<string, unknown>): string | undefined {
	if (typeof args.owner === "string" && args.owner) return args.owner.toLowerCase();
	// Many org-scoped tools (list_org_repository_security_advisories, get_team_members, …)
	// name the org as `org` rather than `owner`; for routing, org === owner.
	if (typeof args.org === "string" && args.org) return args.org.toLowerCase();
	if (typeof args.query === "string") {
		const m = args.query.match(/\brepo:([^/\s]+)\/[^\s]+|\b(?:org|user):([^\s]+)/i);
		const hit = m?.[1] ?? m?.[2];
		if (hit) return hit.toLowerCase();
	}
	if (typeof args.repository === "string" && args.repository.includes("/")) {
		return args.repository.split("/")[0]?.toLowerCase();
	}
	return undefined;
}
