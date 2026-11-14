/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/catalog-compat.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T09:43:26-08:00 (1794678206)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The daemon-side call shape buildCatalog served before the TokenResolver seam (design
 * #175 §2g): the SecretStore doubled as the credential + availability source, the
 * schema-fetch timeout came from GH_BROKER_CATALOG_TIMEOUT_MS, and catalog messages went
 * to stderr (journald). buildCatalog still accepts that shape — a SecretStore as its
 * auth argument — so the suite's pins of this exact behavior run unchanged, and the
 * daemon's one adapter (legacyCatalogOpts, called from src/index.ts) is the host-side
 * half of it; the core (src/catalog.ts) never sees the store. Slice 4 removes this
 * module when the daemon passes the real per-call resolver wiring.
 */

import type { Config, SecretStore, ToolRule, TokenResolver } from "./types.ts";
import { unavailableReason } from "./availability.ts";

export interface LegacyCatalogOpts {
	resolveToken: TokenResolver;
	upstreamTimeoutMs: number;
	log: (message: string) => void;
	unavailable: (rule: ToolRule) => string | undefined;
}

/** The legacy defaults: today's auth, timeout (env-derived, NaN included), sink and availability check. */
export function legacyCatalogOpts(config: Config, store: SecretStore): LegacyCatalogOpts {
	const firstOwner = Object.values(config.owners)[0];
	return {
		// The schema fetch's auth: the first configured owner's read PAT (tool schemas are
		// owner-independent). The person is irrelevant here, exactly as before.
		resolveToken: async () => (firstOwner ? store.resolve(firstOwner.read) : null),
		upstreamTimeoutMs: Number(process.env.GH_BROKER_CATALOG_TIMEOUT_MS ?? 10000),
		log: (message) => console.error(message),
		unavailable: (rule) => unavailableReason(rule, config, store)
	};
}
