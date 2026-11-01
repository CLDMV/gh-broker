/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/npm-setup.mjs
 *	@Date: 2026-10-31T10:58:54-07:00 (1793469534)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:58:17-07:00 (1793476697)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Creates the npm granular access token npm_scaffold uses, the way the npm CLI would, so the
 * installer can drive it end to end:
 *
 *   1. web login     POST /-/v1/login → show the login URL, poll the done URL until approved
 *                    (what `npm login --auth-type=web` does). Yields a short-lived session.
 *   2. token create  POST /-/npm/v1/tokens with the account password and an OTP, both
 *                    prompted for and held only for that request (what `npm token create`
 *                    does). Scope read-write, an expiry, and NO 2FA bypass, so the token
 *                    cannot write anything without a fresh OTP.
 *   3. cleanup       DELETE /-/user/token/<session>, on every path (what `npm logout` does).
 *
 * Nothing here logs or returns the password, the OTP or the session token; the new token is
 * returned to the caller, which stores it in the secret backend.
 */

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_TOKEN_DAYS = 90;
const MAX_ATTEMPTS = 3;

const isHttpsUrl = (u) => {
	try {
		return new URL(u).protocol === "https:";
	} catch {
		return false;
	}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { _raw: text.slice(0, 300) };
	}
}

const detail = (body) => {
	const msg = [body?.error, body?.message, body?.reason, body?._raw].find((v) => typeof v === "string" && v);
	return msg ? `: ${msg.slice(0, 300)}` : "";
};

/** npm's own signal for "this request needs a (valid) OTP": a 401 naming otp. */
export function wantsOtp(res, body) {
	if (res.status !== 401) return false;
	const auth = (res.headers.get("www-authenticate") ?? "").toLowerCase();
	return auth.includes("otp") || /one-time pass/i.test(JSON.stringify(body ?? ""));
}

/**
 * @param {object} o
 * @param {string} [o.registry]
 * @param {string[]} o.scopes                  e.g. ["@cldmv"]
 * @param {string[]} [o.orgs]                  npm orgs to also grant read-write on (org permission)
 * @param {string} o.tokenName                 shown in the npm token list
 * @param {number} [o.days]                    token lifetime
 * @param {(q: string) => Promise<string>} o.promptHidden
 * @param {(m: string) => void} o.log
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.pollTimeoutMs]           how long to wait for the browser approval
 * @returns {Promise<{ token: string, expires?: string }>}
 */
export async function createNpmToken(o) {
	const registry = (o.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
	const doFetch = o.fetch ?? globalThis.fetch;
	const days = o.days ?? DEFAULT_TOKEN_DAYS;
	const session = await webLogin(registry, doFetch, o);
	try {
		return await createToken(registry, doFetch, session, { ...o, days });
	} finally {
		try {
			const res = await doFetch(`${registry}/-/user/token/${encodeURIComponent(session)}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${session}`, "npm-command": "logout" }
			});
			o.log(res.status >= 200 && res.status < 300 ? "  npm login session revoked" : `  note: could not revoke the npm login session (HTTP ${res.status}); it expires on its own`);
		} catch (err) {
			o.log(`  note: could not revoke the npm login session (${err.message}); it expires on its own`);
		}
	}
}

async function webLogin(registry, doFetch, o) {
	const res = await doFetch(`${registry}/-/v1/login`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", "npm-auth-type": "web", "npm-command": "login" },
		body: "{}"
	});
	const body = await readJson(res);
	if (res.status < 200 || res.status >= 300 || !isHttpsUrl(body.loginUrl) || !isHttpsUrl(body.doneUrl)) {
		throw new Error(`npm web login could not start (HTTP ${res.status})${detail(body)}`);
	}
	o.log(`  Log in to npm in a browser (as the account that owns ${o.scopes.join(", ")}):\n\n    ${body.loginUrl}\n\n  Waiting for the login to be approved…`);
	const deadline = Date.now() + (o.pollTimeoutMs ?? 10 * 60_000);
	for (;;) {
		const poll = await doFetch(body.doneUrl, { method: "GET", headers: { accept: "application/json", "npm-command": "login" } });
		const content = await readJson(poll);
		if (poll.status === 200) {
			if (typeof content.token !== "string" || !content.token) throw new Error("npm web login finished without a session");
			o.log("  npm login approved");
			return content.token;
		}
		if (poll.status !== 202) throw new Error(`npm web login failed (HTTP ${poll.status})${detail(content)}`);
		if (Date.now() > deadline) throw new Error("npm web login timed out waiting for approval");
		const retry = Number(poll.headers.get("retry-after"));
		await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000);
	}
}

async function createToken(registry, doFetch, session, o) {
	let password = await o.promptHidden("  npm account password (input hidden, used once, not stored): ");
	let otp = await o.promptHidden("  npm one-time password (input hidden): ");
	const request = {
		name: o.tokenName,
		scopes: o.scopes,
		packages_and_scopes_permission: "read-write",
		...(o.orgs?.length ? { orgs: o.orgs, orgs_permission: "read-write" } : {}),
		expires: o.days
	};
	for (let attempt = 1; ; attempt++) {
		const res = await doFetch(`${registry}/-/npm/v1/tokens`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${session}`,
				"content-type": "application/json",
				accept: "application/json",
				"npm-command": "token",
				...(otp ? { "npm-otp": otp } : {})
			},
			body: JSON.stringify({ ...request, password })
		});
		const body = await readJson(res);
		if (res.status >= 200 && res.status < 300) {
			if (typeof body.token !== "string" || !body.token) throw new Error("npm created a token but did not return it");
			return { token: body.token, ...(typeof body.expires === "string" ? { expires: body.expires } : {}) };
		}
		if (attempt >= MAX_ATTEMPTS) throw new Error(`npm token creation failed (HTTP ${res.status})${detail(body)}`);
		if (wantsOtp(res, body)) {
			otp = await o.promptHidden("  npm rejected the one-time password (expired?). New one-time password (input hidden): ");
		} else if (res.status === 401 || res.status === 403) {
			password = await o.promptHidden("  npm rejected the password. npm account password (input hidden): ");
			otp = await o.promptHidden("  npm one-time password (input hidden): ");
		} else {
			throw new Error(`npm token creation failed (HTTP ${res.status})${detail(body)}`);
		}
	}
}
