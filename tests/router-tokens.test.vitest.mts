import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Router, hostTokenResolver } from "../src/router.ts";

// Security pins for design #175 §2a (slice 4): the TokenResolver is the router's ONLY
// credential path, and it honors the owner and the EFFECTIVE mode it is asked for. A
// write call must resolve the write PAT of the owner the call names; a read call must
// never be handed a write token; an unconfigured owner fails closed (null → the typed
// no-access refusal); a host-narrowed mode is what the resolver is asked for.

function makeConfig(overrides: Record<string, unknown> = {}): any {
	return {
		listen: "unix:/x.sock",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: [
			{ name: "get_me", mode: "read" },
			{ name: "create_pull_request", mode: "write" },
			{ name: "merge_pull_request", mode: "write" }
		],
		owners: {
			alpha: { read: "cred:alpha-read", write: "cred:alpha-write" },
			beta: { read: "cred:beta-read", write: "cred:beta-write" }
		},
		...overrides
	};
}

describe("the router resolves tokens only through the TokenResolver (design #175 §2a)", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn>; has: ReturnType<typeof vi.fn> };
	let upstream: { forward: ReturnType<typeof vi.fn> };
	let logLines: string[];

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logLines.push(a.join(" ")));
		logLines = [];
		secrets = { resolve: vi.fn((ref: string) => `token:${ref}`), has: vi.fn(() => true) };
		upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a write call resolves the WRITE token of the owner the call names, and forwards it", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		const args = { owner: "Beta", repo: "thing", title: "t" };
		await r.call("create_pull_request", args, { user: "tester" });
		expect(secrets.resolve).toHaveBeenCalledWith("cred:beta-write");
		expect(secrets.resolve).not.toHaveBeenCalledWith("cred:beta-read");
		expect(secrets.resolve).not.toHaveBeenCalledWith(expect.stringContaining("alpha"));
		expect(upstream.forward).toHaveBeenCalledWith("create_pull_request", args, "token:cred:beta-write");
	});

	it("a read call never receives a write token", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await r.call("get_me", { owner: "Alpha" }, { user: "tester" });
		expect(secrets.resolve).toHaveBeenCalledWith("cred:alpha-read");
		expect(secrets.resolve).not.toHaveBeenCalledWith(expect.stringMatching(/-write/));
		expect(upstream.forward).toHaveBeenCalledWith("get_me", { owner: "Alpha" }, "token:cred:alpha-read");
	});

	it("a call for one owner never touches another owner's credentials", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await r.call("get_me", { owner: "Beta" }, { user: "tester" });
		expect(secrets.resolve).toHaveBeenCalledTimes(1);
		expect(secrets.resolve).toHaveBeenCalledWith("cred:beta-read");
	});

	it("a token is resolved per call, never cached", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await r.call("get_me", { owner: "Alpha" }, { user: "tester" });
		await r.call("get_me", { owner: "Alpha" }, { user: "tester" });
		expect(secrets.resolve).toHaveBeenCalledTimes(2);
	});

	it("an unconfigured owner fails closed: typed refusal, error audit row, no forward", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("get_me", { owner: "Ghost" }, { user: "tester" })).rejects.toThrow(
			/no credentials configured for owner "ghost" — add it to config\.owners \+ creds/
		);
		expect(upstream.forward).not.toHaveBeenCalled();
		const row = logLines.find((l) => l.includes('"tool":"get_me"'));
		expect(row).toBeDefined();
		expect(JSON.parse(row!)).toMatchObject({ tool: "get_me", user: "tester", owner: "ghost", decision: "error", detail: "no creds for owner" });
	});

	it("the resolver is asked for exactly the effective rule's mode, one TokenRequest per call", async () => {
		// The contract pin: the resolver receives one TokenRequest per call carrying the
		// effective rule's mode, owner and kind. NOTE: the Router hardwires permissivePolicy
		// (src/router.ts:101), which passes the config's rules through untouched — it cannot
		// narrow a mode itself, so the effective mode here IS the config's mode fact. What a
		// host policy that narrows would produce flows through the same indexTools path, and
		// the spy records whatever the routing hands the resolver — that is the contract.
		const requests: any[] = [];
		const spy = vi.fn(async (req: any) => {
			requests.push(req);
			return `token:${req.owner}:${req.mode}`;
		});
		const r = new Router(
			makeConfig({ tools: [{ name: "get_me", mode: "read" }, { name: "create_pull_request", mode: "write" }, { name: "merge_pull_request", mode: "read", otp: false }] }),
			secrets as any,
			upstream as any,
			undefined,
			undefined,
			undefined,
			spy as any
		);
		await r.call("get_me", { owner: "Alpha" }, { user: "tester" });
		await r.call("create_pull_request", { owner: "Beta", repo: "thing", title: "t" }, { user: "tester" });
		await r.call("merge_pull_request", { owner: "Alpha", repo: "thing" }, { user: "tester" });
		expect(requests).toEqual([
			{ person: "tester", owner: "alpha", mode: "read", kind: "github" },
			{ person: "tester", owner: "beta", mode: "write", kind: "github" },
			{ person: "tester", owner: "alpha", mode: "read", kind: "github" }
		]);
		// The forwarded token is the effective mode's: the narrowed (config-read) write tool got the READ token.
		expect(upstream.forward).toHaveBeenNthCalledWith(3, "merge_pull_request", { owner: "Alpha", repo: "thing" }, "token:alpha:read");
	});

	it("npm_scaffold: a resolver null for the npm token is the typed no-access error, with no request sent", async () => {
		const r = new Router(
			makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }], npm: { token: "cred:npm-token", scopes: ["@cldmv"] } }),
			secrets as any,
			upstream as any,
			undefined,
			undefined,
			undefined,
			// The GitHub read resolves; the npm token request returns null.
			vi.fn(async (req: any) => (req.kind === "npm" ? null : "token:github"))
		);
		await expect(r.call("npm_scaffold", { owner: "Alpha", name: "@cldmv/pkg" }, { user: "tester" })).rejects.toThrow(/no npm token configured/);
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("npm_scaffold: a resolver null for the GitHub read is the typed no-access error, with no request sent", async () => {
		const r = new Router(
			makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }], npm: { token: "cred:npm-token", scopes: ["@cldmv"] } }),
			secrets as any,
			upstream as any,
			undefined,
			undefined,
			undefined,
			vi.fn(async () => null)
		);
		await expect(r.call("npm_scaffold", { owner: "Alpha", name: "@cldmv/pkg" }, { user: "tester" })).rejects.toThrow(/no credentials configured for owner "alpha"/);
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("owner \"constructor\" resolves nothing and fails closed like any unconfigured owner", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("get_me", { owner: "constructor" }, { user: "tester" })).rejects.toThrow(/no credentials configured for owner "constructor"/);
		expect(secrets.resolve).not.toHaveBeenCalled();
		expect(upstream.forward).not.toHaveBeenCalled();
		const row = logLines.find((l) => l.includes('"tool":"get_me"'));
		expect(JSON.parse(row!)).toMatchObject({ tool: "get_me", user: "tester", owner: "constructor", decision: "error", detail: "no creds for owner" });
	});
});

describe("hostTokenResolver (the daemon's TokenResolver over config.owners + the store)", () => {
	const config: any = makeConfig({ npm: { token: "cred:npm-token", scopes: ["@cldmv"] } });
	const secrets = { resolve: vi.fn((ref: string) => `token:${ref}`), has: vi.fn(() => true) } as any;
	const resolve = hostTokenResolver(config, secrets);

	it("honors mode: read → the owner's read PAT, write → its write PAT", async () => {
		await expect(resolve({ person: "tester", owner: "alpha", mode: "read", kind: "github" })).resolves.toBe("token:cred:alpha-read");
		await expect(resolve({ person: "tester", owner: "alpha", mode: "write", kind: "github" })).resolves.toBe("token:cred:alpha-write");
	});

	it("an unconfigured (or absent) owner yields null — fail closed", async () => {
		await expect(resolve({ person: "tester", owner: "ghost", mode: "read", kind: "github" })).resolves.toBeNull();
		await expect(resolve({ person: "tester", mode: "read", kind: "github" })).resolves.toBeNull();
	});

	it("kind ghcr has no router path yet and fails closed; kind npm resolves the npm token", async () => {
		await expect(resolve({ person: "tester", owner: "alpha", mode: "write", kind: "ghcr" })).resolves.toBeNull();
		await expect(resolve({ person: "tester", owner: "alpha", mode: "write", kind: "npm" })).resolves.toBe("token:cred:npm-token");
		await expect(hostTokenResolver({ ...config, npm: undefined }, secrets)({ person: "tester", mode: "write", kind: "npm" })).resolves.toBeNull();
	});
});
