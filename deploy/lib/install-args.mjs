/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/install-args.mjs
 *	@Date: 2026-10-31T12:31:29-07:00 (1793475089)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:31:57-07:00 (1793475117)
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
		} else if (a.startsWith("-")) throw new Error(`unknown flag: ${a} (see --help)`);
		else o.positional.push(a);
	}
	if (o.provider !== undefined && o.provider !== "systemd-creds" && o.provider !== "file") {
		throw new Error(`--secrets-provider must be "systemd-creds" or "file"`);
	}
	return o;
}
