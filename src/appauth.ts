/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/appauth.ts
 *	@Date: 2026-07-07T18:39:48-07:00 (1783474788)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T11:30:58-07:00 (1790965858)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import type { Config, SecretStore } from "./types.ts";

/**
 * Provides per-owner GitHub App–authenticated Octokit clients for the operations
 * that fine-grained PATs can't do (`link_issue` → addClosingIssueReference, which
 * is not in the fine-grained-PAT GraphQL schema — only App/classic tokens see it).
 *
 * `@octokit/auth-app` handles the JWT signing + installation-token minting/refresh
 * internally, so there's no hand-rolled token machinery here. The App private key
 * lives only in the broker (systemd-creds), never in the agent.
 */
export class AppAuth {
	private readonly config: Config;
	private readonly appId: number;
	private readonly privateKey: string;
	private readonly cache = new Map<number, Octokit>();

	constructor(config: Config, secrets: SecretStore) {
		if (!config.app) throw new Error("AppAuth: no app config");
		this.config = config;
		this.appId = config.app.appId;
		this.privateKey = secrets.resolve(config.app.privateKey);
	}

	/** App-authed Octokit for this owner's installation, or null if none configured. */
	octokitFor(owner: string): Octokit | null {
		const installationId = this.config.owners[owner]?.installationId;
		if (installationId === undefined) return null;
		let ok = this.cache.get(installationId);
		if (!ok) {
			ok = new Octokit({
				authStrategy: createAppAuth,
				auth: { appId: this.appId, privateKey: this.privateKey, installationId }
			});
			this.cache.set(installationId, ok);
		}
		return ok;
	}
}
