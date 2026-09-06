import { writeFileSync, chmodSync, chownSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";

/**
 * Write the secrets map ({ "<name>": "<token>" }) to `path` as JSON, mode 0640,
 * owned by uid:gid (root:<service-group>) so the service user reads it and the
 * agent user (not in that group, dir 0750) cannot. The file provider counterpart
 * to src/secrets.ts. Never logs a value.
 */
export function writeSecretsFile(path, secrets, { uid = 0, gid, mode = 0o640 } = {}) {
	const json = JSON.stringify(secrets, null, "\t") + "\n";
	writeFileSync(path, json, { mode });
	chmodSync(path, mode);
	if (gid !== undefined) chownSync(path, uid, gid);
}

/**
 * Read an existing secrets file so an upgrade preserves tokens the operator isn't
 * re-entering. Returns {} if the file is absent or unreadable.
 */
export function readSecretsFile(path) {
	if (!existsSync(path)) return {};
	try {
		const v = JSON.parse(readFileSync(path, "utf8"));
		if (!v || typeof v !== "object" || Array.isArray(v)) return {};
		// Keep only non-empty string values — a non-string (number/object) must never
		// be treated as a token (it would crash encryption or be written back invalid).
		const out = {};
		for (const [name, val] of Object.entries(v)) if (typeof val === "string" && val.length > 0) out[name] = val;
		return out;
	} catch {
		return {};
	}
}

/**
 * Remove a plaintext secrets file — used when the operator switches to the
 * systemd-creds provider, so the tokens don't linger on disk and defeat
 * "encrypted at rest". Best-effort zero-overwrite before unlink. No-op if absent.
 */
export function removeSecretsFile(path) {
	if (!existsSync(path)) return;
	try {
		writeFileSync(path, Buffer.alloc(statSync(path).size, 0));
	} catch {
		// overwrite is best-effort; unlink still happens below
	}
	rmSync(path, { force: true });
}

/** The distinct cred names a config's owners + app reference (strips the "cred:" prefix). */
export function referencedCredNames(config) {
	const names = new Set();
	const add = (ref) => {
		if (typeof ref === "string" && ref.startsWith("cred:")) names.add(ref.slice("cred:".length));
	};
	for (const owner of Object.values(config.owners ?? {})) {
		add(owner.read);
		add(owner.write);
	}
	if (config.app) add(config.app.privateKey);
	return [...names];
}
