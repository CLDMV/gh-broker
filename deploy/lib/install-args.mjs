/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/install-args.mjs
 *	@Date: 2026-10-31T12:31:29-07:00 (1793475089)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T00:40:47-07:00 (1793518847)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The installer's command-line parsing, kept apart from install.mjs (which needs root and
 * a systemd host) so it can be tested. Every problem throws; install.mjs turns that into
 * its usual fatal message.
 */

import { assertSafeCredName } from "./secret-store.mjs";

export const NPM_SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;
export const NPM_ORG = /^[a-z0-9][a-z0-9._~-]*$/;
/** A GitHub owner (user or org) name, lowercase, as config.owners keys must be. */
export const GH_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const IMAGE_GLOB = /^[a-z0-9*](?:[a-z0-9._*-]*[a-z0-9*])?(?:\/[a-z0-9*](?:[a-z0-9._*-]*[a-z0-9*])?)*$/;

/** env var that supplies the token for cred `name`: GH_BROKER_SECRET_<NAME>. */
export const envSecretKey = (name) => "GH_BROKER_SECRET_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export function parseArgs(argv) {
	const o = { positional: [], nonInteractive: false, createAgentUser: false, npm: false, npmScopes: [], npmOrgs: [], cliSecrets: {} };
	// Consume the value after a value-taking flag, failing if it's missing or is
	// itself a flag — so `--agent-user --secrets-provider file` can't silently take
	// "--secrets-provider" as the username and proceed with an unintended user.
	const value = (i, flag) => {
		const v = argv[i];
		if (v === undefined || v.startsWith("-")) throw new Error(`${flag} requires a value (see --help)`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") o.help = true;
		else if (a === "-y" || a === "--non-interactive") o.nonInteractive = true;
		else if (a === "--create-agent-user") o.createAgentUser = true;
		else if (a === "--agent-user") o.agentUser = value(++i, a);
		else if (a === "--secrets-provider") o.provider = value(++i, a);
		else if (a === "--secrets-file") o.secretsFile = value(++i, a);
		else if (a === "--secret") {
			const pair = value(++i, a);
			const eq = pair.indexOf("=");
			if (eq <= 0 || eq === pair.length - 1) throw new Error("--secret takes <cred-name>=<token> (see --help)");
			o.cliSecrets[assertSafeCredName(pair.slice(0, eq))] = pair.slice(eq + 1);
		} else if (a === "--npm") o.npm = true;
		else if (a === "--npm-scope") {
			const s = value(++i, a);
			if (!NPM_SCOPE.test(s)) throw new Error(`--npm-scope must be a lowercase npm scope like "@cldmv", got "${s}"`);
			o.npmScopes.push(s);
		} else if (a === "--npm-org") {
			const org = value(++i, a);
			if (!NPM_ORG.test(org)) throw new Error(`--npm-org must be a lowercase npm org name like "cldmv", got "${org}"`);
			o.npmOrgs.push(org);
		} else if (a === "--npm-token-days") {
			const days = value(++i, a);
			if (!/^[1-9][0-9]{0,2}$/.test(days)) throw new Error("--npm-token-days must be a whole number of days");
			o.npmTokenDays = Number(days);
		} else if (a === "--config") o.configFile = value(++i, a);
		else if (a === "--owner") {
			const org = value(++i, a);
			if (!GH_OWNER.test(org)) throw new Error(`--owner must be a lowercase GitHub owner name like "acme", got "${org}"`);
			(o.owners ??= []).push(org);
		} else if (a === "--installation-id") {
			const pair = value(++i, a);
			const eq = pair.indexOf("=");
			const org = pair.slice(0, eq);
			const id = pair.slice(eq + 1);
			if (eq <= 0 || !GH_OWNER.test(org) || !/^[1-9][0-9]{0,14}$/.test(id)) throw new Error("--installation-id takes <owner>=<numeric id> (see --help)");
			(o.installationIds ??= {})[org] = Number(id);
		} else if (a === "--default-owner") {
			const org = value(++i, a);
			if (!GH_OWNER.test(org)) throw new Error(`--default-owner must be a lowercase GitHub owner name like "acme", got "${org}"`);
			o.defaultOwner = org;
		} else if (a === "--listen") {
			const addr = value(++i, a);
			if (!/^unix:\/.+/.test(addr)) throw new Error(`--listen must be a "unix:<absolute path>" address, got "${addr}"`);
			o.listen = addr;
		} else if (a === "--upstream") {
			const url = value(++i, a);
			if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`--upstream must be an http(s) URL, got "${url}"`);
			o.upstream = url;
		} else if (a === "--app-id") {
			const id = value(++i, a);
			if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new Error("--app-id must be the numeric GitHub App id");
			o.appId = Number(id);
		} else if (a === "--app-private-key") o.appPrivateKey = assertSafeCredName(value(++i, a).replace(/^cred:/, ""));
		else if (a === "--secrets-path") {
			const path = value(++i, a);
			if (!path.startsWith("/")) throw new Error(`--secrets-path must be an absolute path, got "${path}"`);
			o.secretsPath = path;
		} else if (a === "--npm-registry") {
			const url = value(++i, a);
			if (!/^https:\/\/\S+$/.test(url)) throw new Error(`--npm-registry must be an https URL, got "${url}"`);
			o.npmRegistry = url;
		} else if (a === "--ghcr-owner") {
			const org = value(++i, a);
			if (!GH_OWNER.test(org)) throw new Error(`--ghcr-owner must be a lowercase GitHub owner name like "acme", got "${org}"`);
			o.ghcrOwner = org;
		} else if (a === "--ghcr-username") {
			const login = value(++i, a);
			if (!GH_LOGIN.test(login)) throw new Error(`--ghcr-username must be a GitHub login, got "${login}"`);
			o.ghcrUsername = login;
		} else if (a === "--ghcr-image") {
			const img = value(++i, a);
			if (img.length > 255 || !IMAGE_GLOB.test(img)) throw new Error(`--ghcr-image must be a lowercase image name or glob like "app" or "app-*", got "${img}"`);
			(o.ghcrImages ??= []).push(img);
		} else if (a === "--ghcr-drop-dir") {
			const dir = value(++i, a);
			if (!dir.startsWith("/")) throw new Error(`--ghcr-drop-dir must be an absolute path, got "${dir}"`);
			o.ghcrDropDir = dir;
		} else if (a === "--ghcr-max-archive-bytes") {
			const n = value(++i, a);
			if (!/^[1-9][0-9]{0,15}$/.test(n) || !Number.isSafeInteger(Number(n))) throw new Error("--ghcr-max-archive-bytes must be a positive whole number of bytes");
			o.ghcrMaxArchiveBytes = Number(n);
		} else if (a === "--protect-release-tags") o.protectReleaseTags = true;
		else if (a === "--no-protect-release-tags") o.protectReleaseTags = false;
		else if (a.startsWith("-")) throw new Error(`unknown flag: ${a} (see --help)`);
		else o.positional.push(a);
	}
	if (o.provider !== undefined && o.provider !== "systemd-creds" && o.provider !== "file") {
		throw new Error(`--secrets-provider must be "systemd-creds" or "file"`);
	}
	if (o.npmRegistry !== undefined && !o.npm) throw new Error("--npm-registry only applies together with --npm");
	if (o.appPrivateKey !== undefined && o.appId === undefined) throw new Error("--app-private-key needs --app-id");
	if (o.ghcrOwner !== undefined && (o.ghcrUsername === undefined || !o.ghcrImages)) {
		throw new Error("--ghcr-owner needs --ghcr-username and at least one --ghcr-image");
	}
	if (o.ghcrOwner === undefined && (o.ghcrUsername !== undefined || o.ghcrImages)) {
		throw new Error("--ghcr-username and --ghcr-image need --ghcr-owner (several GHCR owners go in a --config file)");
	}
	return o;
}
