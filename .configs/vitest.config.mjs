/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2026-08-02T16:55:52-07:00 (1785714952)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-06T06:12:07-08:00 (1793974327)
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
			// Every CLI and installer module under src/cli is measured; the host-facing ones
			// (systemd, prompts, smoke test) are tested with their child processes and sockets mocked.
			include: ["src/**/*.ts"],
			// index.ts is the process entrypoint (arg parse + wire + listen);
			// types.ts is type-only (elided at compile time — zero runtime code).
			// Neither is unit-testable. server.ts (the stdio<->socket bridge) is
			// deliberately NOT excluded — its logic is real and only partly covered,
			// so it should show honestly rather than be hidden. Measured units are
			// the pure logic: config, router/owner-routing, catalog, audit, secrets,
			// verbs, upstream, appauth.
			// The CLI has the same split: src/bin/gh-broker.ts (the command's entrypoint),
			// src/cli/install.ts (the root-only installer run, step by step against the host)
			// and src/cli/real-deps.ts (the real effects the tested CLI modules take as deps)
			// are wiring; their logic lives in the measured src/cli modules.
			exclude: ["tests/**", "**/*.json", "src/index.ts", "src/types.ts", "src/bin/gh-broker.ts", "src/cli/install.ts", "src/cli/real-deps.ts"],
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});
