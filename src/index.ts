import { loadConfig } from "./config.ts";
import { loadSecretStore } from "./secrets.ts";
import { UpstreamPool } from "./upstream.ts";
import { Router } from "./router.ts";
import { AppAuth } from "./appauth.ts";
import { buildCatalog } from "./catalog.ts";
import { startServer } from "./server.ts";

function argConfig(): string {
	const i = process.argv.indexOf("--config");
	const next = process.argv[i + 1];
	if (i >= 0 && next) return next;
	return process.env.GH_BROKER_CONFIG ?? "/etc/gh-broker/config.json";
}

async function main(): Promise<void> {
	const config = loadConfig(argConfig());
	const secrets = loadSecretStore(config); // eagerly validates every referenced credential
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
