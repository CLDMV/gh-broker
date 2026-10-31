/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2026-08-02T16:55:52-07:00 (1785714952)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:58:10-07:00 (1793476690)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
	root,
	test: {
		include: ["tests/**/*.test.vitest.mts"],
		exclude: ["node_modules", "dist"],
		environment: "node",
		testTimeout: 30000,
		reporters: ["dot"],
		coverage: {
			provider: "v8",
			// The installer's pure decision modules are measured too; the rest of deploy/lib
			// (systemd, prompts, smoke test) drives the host and isn't unit-tested.
			include: ["src/**/*.ts", "deploy/lib/credentials.mjs", "deploy/lib/install-args.mjs", "deploy/lib/npm-setup.mjs"],
			// index.ts is the process entrypoint (arg parse + wire + listen);
			// types.ts is type-only (elided at compile time — zero runtime code).
			// Neither is unit-testable. server.ts (the stdio<->socket bridge) is
			// deliberately NOT excluded — its logic is real and only partly covered,
			// so it should show honestly rather than be hidden. Measured units are
			// the pure logic: config, router/owner-routing, catalog, audit, secrets,
			// verbs, upstream, appauth.
			exclude: ["tests/**", "**/*.json", "src/index.ts", "src/types.ts"],
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});
