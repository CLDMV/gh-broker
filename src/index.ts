import { loadConfig } from "./config.ts";
import { loadSecretStore } from "./secrets.ts";
import { UpstreamPool } from "./upstream.ts";
import { Router } from "./router.ts";
import { AppAuth } from "./appauth.ts";
import { buildCatalog } from "./catalog.ts";
import { startServer } from "./server.ts";
import { resolveConfigPath } from "./paths.ts";

function argConfig(): string {
	const i = process.argv.indexOf("--config");
	const explicit = i >= 0 ? process.argv[i + 1] : undefined;
	return resolveConfigPath(explicit);
}

async function main(): Promise<void> {
	const configPath = argConfig();

	// --print-paths: emit the resolved config + secrets paths and exit. The
	// installer uses this so there is one path resolver (src/paths.ts), no drift.
	// Handled before loadConfig, since the config may not exist yet on first install.
	if (process.argv.includes("--print-paths")) {
		const { resolveSecretsPath } = await import("./paths.ts");
		console.log(JSON.stringify({ config: configPath, secrets: resolveSecretsPath() }));
		return;
	}

	const config = loadConfig(configPath);
	const secrets = loadSecretStore(config); // eagerly validates every referenced credential

	// --check: validate that the config parses and every referenced credential
	// resolves, then exit WITHOUT starting the server. The installer runs this to
	// fail an install/upgrade early on a bad config instead of at service start.
	if (process.argv.includes("--check")) {
		console.log(JSON.stringify({ event: "config-ok", config: configPath, owners: Object.keys(config.owners), tools: config.tools.length }));
		return;
	}

	const upstream = new UpstreamPool(config);

	// Optional GitHub App (for link_issue). Non-fatal: a misconfigured App disables
	// link_issue but never takes down the read/write path.
	let appAuth: AppAuth | undefined;
	if (config.app) {
		try {
			appAuth = new AppAuth(config, secrets);
		} catch (err) {
			console.error(`gh-broker: app-auth disabled (link_issue unavailable): ${(err as Error).message}`);
		}
	}

	const router = new Router(config, secrets, upstream, appAuth);
	const catalog = await buildCatalog(config, secrets, upstream);
	await startServer(config, router, catalog);
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			event: "listening",
			listen: config.listen,
			owners: Object.keys(config.owners),
			app: appAuth ? "enabled" : "none",
			tools: catalog.map((t) => t.name)
		})
	);
}

main().catch((err: unknown) => {
	console.error(`gh-broker: fatal: ${(err as Error).message}`);
	process.exit(1);
});
