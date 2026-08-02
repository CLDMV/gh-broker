import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
	root,
	test: {
		include: ["tests/**/*.test.mts"],
		exclude: ["node_modules", "dist"],
		environment: "node",
		testTimeout: 30000,
		reporters: ["dot"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
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
