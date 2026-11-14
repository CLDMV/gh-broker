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

	it("a host-narrowed mode is honoured: the effective mode from the manifest policy is what the resolver is asked for", async () => {
		// merge_pull_request is manifest-declared "write"; the config narrows it to "read"
		// (the permissive policy serves config as configured — a narrowing collects no
		// warning) and turns its gate off so the call can run without an OTP setup. The
		// effective mode is what reaches the resolver: the READ token.
		const r = new Router(makeConfig({ tools: [{ name: "merge_pull_request", mode: "read", otp: false }] }), secrets as any, upstream as any);
		await r.call("merge_pull_request", { owner: "Alpha", repo: "thing" }, { user: "tester" });
		expect(secrets.resolve).toHaveBeenCalledWith("cred:alpha-read");
		expect(secrets.resolve).not.toHaveBeenCalledWith(expect.stringMatching(/-write/));
		expect(upstream.forward).toHaveBeenCalledWith("merge_pull_request", { owner: "Alpha", repo: "thing" }, "token:cred:alpha-read");
		const row = logLines.find((l) => l.includes('"decision":"forward"'));
		expect(JSON.parse(row!)).toMatchObject({ tool: "merge_pull_request", mode: "read", ok: true });
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
