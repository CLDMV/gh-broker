import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, chownSync, writeFileSync, cpSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

/** spawnSync wrapper: throws on non-zero unless opts.allowFail. Returns the result. */
export function run(cmd, args = [], opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
	if (r.status !== 0 && !opts.allowFail) {
		throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
	}
	return r;
}

export function has(cmd) {
	return spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
}
export function isRoot() {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

export function userExists(name) {
	return run("id", [name], { allowFail: true, stdio: "ignore" }).status === 0;
}
export function groupExists(name) {
	return run("getent", ["group", name], { allowFail: true }).status === 0;
}
export function gidOf(name) {
	const r = run("getent", ["group", name], { allowFail: true });
	if (r.status !== 0) return undefined;
	const gid = Number(r.stdout.split(":")[2]);
	return Number.isFinite(gid) ? gid : undefined;
}
export function uidOf(name) {
	const r = run("id", ["-u", name], { allowFail: true });
	if (r.status !== 0) return undefined;
	const uid = Number(r.stdout.trim());
	return Number.isFinite(uid) ? uid : undefined;
}

export function ensureGroup(name) {
	if (!groupExists(name)) run("groupadd", ["--system", name]);
}
export function addUserToGroup(user, group) {
	run("usermod", ["--append", "--groups", group, user]);
}

/** Create the dedicated service user + its group + the socket bridge group (idempotent). */
export function ensureServiceUser(svcUser, svcGroup, clientsGroup) {
	ensureGroup(svcGroup);
	ensureGroup(clientsGroup);
	if (!userExists(svcUser)) {
		run("useradd", [
			"--system",
			"--gid", svcGroup,
			"--groups", clientsGroup,
			"--home-dir", "/nonexistent",
			"--shell", "/usr/sbin/nologin",
			"--comment", "CLDMV gh-broker service",
			svcUser
		]);
	} else {
		addUserToGroup(svcUser, clientsGroup);
	}
}

/** Create a plain unprivileged agent user with a home + login shell, and no sudo. */
export function createAgentUser(name) {
	run("useradd", ["--create-home", "--shell", "/bin/bash", name]);
}

/**
 * Migrate a token from the legacy systemd-creds store: decrypt the host-bound
 * `<name>.cred` (as root, same host) into plaintext for the new secrets file.
 * Returns the token, or null if there's nothing to migrate (file absent, no
 * systemd-creds, wrong host/name → can't decrypt). Never logs the value.
 */
export function trySystemdCredDecrypt(name, credFile) {
	if (!existsSync(credFile) || !has("systemd-creds")) return null;
	try {
		const r = run("systemd-creds", ["decrypt", `--name=${name}`, credFile, "-"], { allowFail: true });
		if (r.status !== 0) return null;
		const val = r.stdout.replace(/\r?\n$/, "");
		return val || null;
	} catch {
		return null;
	}
}

/** Point /usr/local/bin/{node,npm,npx} at the given node binary's dir (the single indirection). */
export function pointNodeSymlinks(nodeBin) {
	const binDir = dirname(nodeBin);
	const linked = [];
	for (const b of ["node", "npm", "npx"]) {
		const src = join(binDir, b);
		if (existsSync(src)) {
			rmSync(`/usr/local/bin/${b}`, { force: true });
			symlinkSync(src, `/usr/local/bin/${b}`);
			linked.push(b);
		}
	}
	return linked;
}

/** The real path of the node running this installer — the node the service will use. */
export function currentNodeBin() {
	return realpathSync(process.execPath);
}

function mkdirp(path, mode, uid, gid) {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
	chmodSync(path, mode);
	if (uid !== undefined && gid !== undefined) chownSync(path, uid, gid);
}

/** Create /etc/gh-broker (0750 root:group) and /opt/gh-broker (0755 svcUser:group). */
export function ensureDirs(configDir, appDir, svcUser, svcGroup) {
	const gid = gidOf(svcGroup);
	const uid = uidOf(svcUser);
	mkdirp(configDir, 0o750, 0, gid);
	mkdirp(appDir, 0o755, uid, gid);
}

/** Install the systemd unit and reload. */
export function installUnit(srcPath, unitPath = "/etc/systemd/system/gh-broker.service") {
	cpSync(srcPath, unitPath);
	chmodSync(unitPath, 0o644);
	run("systemctl", ["daemon-reload"]);
}
export function enableService() {
	run("systemctl", ["enable", "gh-broker.service"], { allowFail: true });
}
export function restartService() {
	run("systemctl", ["restart", "gh-broker.service"]);
}
export function serviceActive() {
	return run("systemctl", ["is-active", "gh-broker.service"], { allowFail: true }).stdout.trim();
}

/** Sync the built dist/ into the app dir and chown it to the service user. */
export function deployDist(srcDir, destDir, svcUser, svcGroup) {
	const gid = gidOf(svcGroup);
	const uid = uidOf(svcUser);
	mkdirp(destDir, 0o755, uid, gid);
	const dist = join(destDir, "dist");
	if (has("rsync")) {
		run("rsync", ["-a", "--delete", `${srcDir}/`, `${dist}/`]);
	} else {
		rmSync(dist, { recursive: true, force: true });
		cpSync(srcDir, dist, { recursive: true });
	}
	run("chown", ["-R", `${uid}:${gid}`, destDir]);
}

/** Write the token-free config, 0640 root:group. */
export function writeConfigFile(path, obj, svcGroup) {
	const gid = gidOf(svcGroup);
	writeFileSync(path, JSON.stringify(obj, null, "\t") + "\n", { mode: 0o640 });
	chmodSync(path, 0o640);
	if (gid !== undefined) chownSync(path, 0, gid);
}
