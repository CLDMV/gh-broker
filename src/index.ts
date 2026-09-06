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
	if (i >= 0) {
		// Fail fast on `--config` with no value (or a flag as the "value") rather than
		// silently falling back to env/default and hiding the operator's mistake.
		const explicit = process.argv[i + 1];
		if (!explicit || explicit.startsWith("-")) throw new Error("--config requires a path argument");
		return resolveConfigPath(explicit);
	}
	return resolveConfigPath(undefined);
}

async function main(): Promise<void> {
	const configPath = argConfig();

	// --print-paths: emit the resolved config + secrets paths and exit. The
	// installer uses this so there is one path resolver (src/paths.ts), no drift.
	// Honor a deployed config's secrets.path override when the config already exists
	// (upgrades); fall back to the default when it doesn't (first install) or is
	// unparseable — this must not require a valid config to run.
	if (process.argv.includes("--print-paths")) {
		const { resolveSecretsPath } = await import("./paths.ts");
		let secretsOverride: string | undefined;
		try {
			secretsOverride = loadConfig(configPath).secrets?.path;
		} catch {
			secretsOverride = undefined;
		}
		console.log(JSON.stringify({ config: configPath, secrets: resolveSecretsPath(secretsOverride) }));
		return;
	}

	const config = loadConfig(configPath);

	// --check: validate the config parses (and, where possible, that credentials
	// resolve), then exit WITHOUT starting the server. The installer runs this to
	// fail an install/upgrade early. The file provider validates here; the
	// systemd-creds provider can only resolve under systemd (needs
	// $CREDENTIALS_DIRECTORY), so it's checked at service start / by the smoke test.
	if (process.argv.includes("--check")) {
		const provider = config.secrets?.provider ?? "systemd-creds";
		// Truthy, not just "defined": the systemd-creds store treats an empty
		// $CREDENTIALS_DIRECTORY as unset (if (!dir)), so --check must too — otherwise
		// it would attempt secret resolution and fail where it should report unchecked.
		const secretsChecked = provider === "file" || Boolean(process.env.CREDENTIALS_DIRECTORY);
		if (secretsChecked) loadSecretStore(config);
		console.log(JSON.stringify({ event: "config-ok", config: configPath, provider, secretsChecked, owners: Object.keys(config.owners), tools: config.tools.length }));
		return;
	}

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
