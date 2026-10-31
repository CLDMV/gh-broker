import { describe, it, expect, vi } from "vitest";
import { createNpmToken, wantsOtp } from "../deploy/lib/npm-setup.mjs";

const SESSION = "npm_SESSIONTOKEN";
const NEW_TOKEN = "npm_NEWGRANULARTOKEN";
const PASSWORD = "hunter2-secret";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
const reply = (r: Reply) => ({
	status: r.status,
	headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
	text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}))
});

/** A scripted registry: each route pops its next reply. */
function fakeNpm(script: { login?: Reply; polls?: Reply[]; tokens?: Reply[]; logout?: Reply | Error }) {
	const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = [];
	const polls = [...(script.polls ?? [{ status: 200, body: { token: SESSION } }])];
	const tokens = [...(script.tokens ?? [{ status: 201, body: { token: NEW_TOKEN, expires: "2027-01-29T00:00:00.000Z", key: "k" } }])];
	const fetch = vi.fn(async (url: string, init: any) => {
		calls.push({ method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
		const path = new URL(url).pathname;
		if (path === "/-/v1/login") return reply(script.login ?? { status: 200, body: { loginUrl: "https://www.npmjs.com/login?next=/login/cli/abc", doneUrl: "https://registry.npmjs.org/-/v1/done?authId=abc" } });
		if (path === "/-/v1/done") return reply(polls.shift() ?? { status: 500 });
		if (path === "/-/npm/v1/tokens") return reply(tokens.shift() ?? { status: 500 });
		if (path.startsWith("/-/user/token/")) {
			if (script.logout instanceof Error) throw script.logout;
			return reply(script.logout ?? { status: 200, body: { ok: true } });
		}
		throw new Error(`unexpected ${init.method} ${url}`);
	});
	return { fetch, calls };
}

/** Every answer, the OTP included, is read through the hidden prompt, in call order. */
function prompts(answers: string[]) {
	return { promptHidden: vi.fn(async () => answers.shift() ?? "") };
}

const run = (npm: ReturnType<typeof fakeNpm>, p = prompts([PASSWORD, "111111"]), extra: Record<string, unknown> = {}) => {
	const logs: string[] = [];
	const done = createNpmToken({ scopes: ["@cldmv"], tokenName: "gh-broker test", fetch: npm.fetch as any, log: (m: string) => logs.push(m), ...p, ...extra });
	return { done, logs, p };
};

describe("createNpmToken", () => {
	it("logs in through the web flow, creates a scoped read-write token without 2FA bypass, and revokes the session", async () => {
		const npm = fakeNpm({});
		const { done, logs } = run(npm);
		await expect(done).resolves.toEqual({ token: NEW_TOKEN, expires: "2027-01-29T00:00:00.000Z" });
		expect(logs.join("\n")).toContain("https://www.npmjs.com/login?next=/login/cli/abc");

		const create = npm.calls.find((c) => c.url.endsWith("/-/npm/v1/tokens"))!;
		expect(create.headers.authorization).toBe(`Bearer ${SESSION}`);
		expect(create.headers["npm-otp"]).toBe("111111");
		expect(create.body).toEqual({ name: "gh-broker test", scopes: ["@cldmv"], packages_and_scopes_permission: "read-write", expires: 90, password: PASSWORD });
		expect(create.body).not.toHaveProperty("bypass_2fa");

		const logout = npm.calls.at(-1)!;
		expect(logout.method).toBe("DELETE");
		expect(logout.url).toBe(`https://registry.npmjs.org/-/user/token/${SESSION}`);
		expect(logs).toContain("  npm login session revoked");
	});

	it("waits while the login is pending, honouring retry-after", async () => {
		vi.useFakeTimers();
		try {
			const npm = fakeNpm({ polls: [{ status: 202, headers: { "retry-after": "2" } }, { status: 202 }, { status: 200, body: { token: SESSION } }] });
			const { done } = run(npm);
			await vi.advanceTimersByTimeAsync(3000);
			await expect(done).resolves.toMatchObject({ token: NEW_TOKEN });
			expect(npm.calls.filter((c) => c.url.includes("/-/v1/done"))).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up when the login is never approved", async () => {
		const npm = fakeNpm({ polls: Array.from({ length: 5 }, () => ({ status: 202, headers: { "retry-after": "0.001" } })) });
		await expect(run(npm, undefined, { pollTimeoutMs: -1 }).done).rejects.toThrow(/timed out waiting for approval/);
	});

	it("re-prompts for the OTP when npm rejects it", async () => {
		const npm = fakeNpm({ tokens: [{ status: 401, headers: { "www-authenticate": "OTP" } }, { status: 201, body: { token: NEW_TOKEN } }] });
		const p = prompts([PASSWORD, "111111", "222222"]);
		await expect(run(npm, p).done).resolves.toEqual({ token: NEW_TOKEN });
		const creates = npm.calls.filter((c) => c.url.endsWith("/-/npm/v1/tokens"));
		expect(creates.map((c) => c.headers["npm-otp"])).toEqual(["111111", "222222"]);
		// password + first OTP + the replacement OTP: the password is not asked for again
		expect(p.promptHidden).toHaveBeenCalledTimes(3);
	});

	it("re-prompts for the password (and a new OTP) when npm rejects it", async () => {
		const npm = fakeNpm({ tokens: [{ status: 401, body: { error: "invalid password" } }, { status: 201, body: { token: NEW_TOKEN } }] });
		const p = prompts([PASSWORD, "111111", "right-password", "222222"]);
		await expect(run(npm, p).done).resolves.toEqual({ token: NEW_TOKEN });
		expect(npm.calls.filter((c) => c.url.endsWith("/-/npm/v1/tokens")).map((c) => c.body.password)).toEqual([PASSWORD, "right-password"]);
	});

	it("stops after three attempts and still revokes the session", async () => {
		const otpNo = { status: 401, headers: { "www-authenticate": "OTP" } };
		const npm = fakeNpm({ tokens: [otpNo, otpNo, { status: 401, body: { error: "You must provide a one-time pass." } }] });
		const { done, logs } = run(npm, prompts([PASSWORD, "1", "2", "3"]));
		await expect(done).rejects.toThrow(/npm token creation failed \(HTTP 401\)/);
		expect(npm.calls.at(-1)!.method).toBe("DELETE");
		expect(logs).toContain("  npm login session revoked");
	});

	it("fails on an unexpected registry error, revoking the session", async () => {
		const npm = fakeNpm({ tokens: [{ status: 400, body: { message: "expires must be at most 90 days" } }] });
		await expect(run(npm).done).rejects.toThrow(/HTTP 400\): expires must be at most 90 days/);
		expect(npm.calls.at(-1)!.method).toBe("DELETE");
	});

	it("fails when npm returns no token", async () => {
		await expect(run(fakeNpm({ tokens: [{ status: 201, body: {} }] })).done).rejects.toThrow(/did not return it/);
	});

	it("reports an unrevokable session as a note, not a failure", async () => {
		const a = run(fakeNpm({ logout: { status: 500 } }));
		await expect(a.done).resolves.toMatchObject({ token: NEW_TOKEN });
		expect(a.logs.at(-1)).toMatch(/could not revoke the npm login session \(HTTP 500\)/);
		const b = run(fakeNpm({ logout: new Error("socket hang up") }));
		await expect(b.done).resolves.toMatchObject({ token: NEW_TOKEN });
		expect(b.logs.at(-1)).toMatch(/could not revoke the npm login session \(socket hang up\)/);
	});

	it.each([
		[{ status: 404, body: "Not Found" }, /could not start \(HTTP 404\): Not Found/],
		[{ status: 200, body: { loginUrl: "http://insecure", doneUrl: "https://x" } }, /could not start/]
	] as Array<[Reply, RegExp]>)("fails when the web login cannot start (%#)", async (login, msg) => {
		const npm = fakeNpm({ login });
		await expect(run(npm).done).rejects.toThrow(msg);
		expect(npm.calls).toHaveLength(1);
	});

	it.each([
		[{ status: 200, body: {} }, /finished without a session/],
		[{ status: 403, body: { error: "denied" } }, /web login failed \(HTTP 403\): denied/]
	] as Array<[Reply, RegExp]>)("fails when the login poll goes wrong (%#)", async (poll, msg) => {
		await expect(run(fakeNpm({ polls: [poll] })).done).rejects.toThrow(msg);
	});

	it("never logs the password, the OTP or any token", async () => {
		const { done, logs } = run(fakeNpm({}));
		await done;
		const all = logs.join("\n");
		for (const secret of [PASSWORD, "111111", SESSION, NEW_TOKEN]) expect(all).not.toContain(secret);
	});

	it("adds org read-write only when orgs are given", async () => {
		const npm = fakeNpm({});
		await run(npm, undefined, { orgs: ["cldmv"] }).done;
		expect(npm.calls.find((c) => c.url.endsWith("/tokens"))!.body).toMatchObject({ scopes: ["@cldmv"], orgs: ["cldmv"], orgs_permission: "read-write" });
	});

	it("rejects a login URL that does not parse", async () => {
		const npm = fakeNpm({ login: { status: 200, body: { loginUrl: "not a url", doneUrl: "https://registry.npmjs.org/-/v1/done" } } });
		await expect(run(npm).done).rejects.toThrow(/could not start/);
	});

	it("sends no npm-otp header when the code is left empty", async () => {
		const npm = fakeNpm({});
		await run(npm, prompts([PASSWORD, ""])).done;
		expect(npm.calls.find((c) => c.url.endsWith("/tokens"))!.headers).not.toHaveProperty("npm-otp");
	});

	it("uses the global fetch when none is passed", async () => {
		const npm = fakeNpm({});
		vi.stubGlobal("fetch", npm.fetch);
		try {
			const logs: string[] = [];
			await expect(createNpmToken({ scopes: ["@cldmv"], tokenName: "t", log: (m: string) => logs.push(m), ...prompts([PASSWORD, "111111"]) })).resolves.toMatchObject({ token: NEW_TOKEN });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("uses a custom registry and token lifetime", async () => {
		const npm = fakeNpm({ login: { status: 200, body: { loginUrl: "https://npm.example.test/login", doneUrl: "https://npm.example.test/-/v1/done?x" } } });
		await run(npm, undefined, { registry: "https://npm.example.test/", days: 30 }).done;
		expect(npm.calls[0]!.url).toBe("https://npm.example.test/-/v1/login");
		expect(npm.calls.find((c) => c.url.endsWith("/tokens"))!.body.expires).toBe(30);
	});
});

describe("wantsOtp", () => {
	const res = (status: number, h: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => h[n] ?? null } });
	it("recognises npm's OTP signals and nothing else", () => {
		expect(wantsOtp(res(401, { "www-authenticate": "OTP" }), {})).toBe(true);
		expect(wantsOtp(res(401), { error: "You must provide a one-time pass." })).toBe(true);
		expect(wantsOtp(res(401), { error: "bad password" })).toBe(false);
		expect(wantsOtp(res(401), undefined)).toBe(false);
		expect(wantsOtp(res(403, { "www-authenticate": "OTP" }), {})).toBe(false);
	});
});
