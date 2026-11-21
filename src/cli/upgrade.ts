/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/upgrade.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T12:23:30-08:00 (1795292610)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker upgrade` (#223): the whole upgrade under one sudo. npm installs the package, the
 * NEWLY installed binary's `install` runs as a child process (the running CLI is still the old
 * code, so it must not install itself), and so does its `agent reconnect`, which tells the
 * restarted broker's sessions to pick it up. Each step reports; the command stops at the first
 * failure and prints which step failed and what to run to finish (the failed step's command, then
 * the remaining ones). The install flags are validated before anything runs, the target version
 * must be a real semver, and "already installed" is judged against the DEPLOYED service (a run
 * where npm succeeded but install never did must still install). Every effect is injected.
 */
import { NPM_INSTALL_COMMAND } from "./agents.ts";
import { parseArgs } from "./install-args.ts";
import type { ReconnectDeps } from "./reconnect.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** The effects `gh-broker upgrade` uses (the reconnect effects for its last step, plus its own). */
export interface UpgradeDeps extends ReconnectDeps {
	/** The version of the globally installed npm package, when there is one. */
	installedVersion: () => string | undefined;
	/** The version the DEPLOYED service runs (the /opt copy), when known. */
	deployedVersion: () => string | undefined;
	/** The version npm's registry has (undefined when it can't be reached). */
	latestVersion: () => string | undefined;
	/** Step 1: install (or upgrade) the global npm package. */
	npmInstall: (spec: string) => void;
	/** Step 2 (and step 3): run the newly installed binary as a child process with these arguments. */
	runNewBinary: (args: string[]) => void;
}

export const UPGRADE_HELP = `gh-broker upgrade — the whole upgrade under one sudo.

Usage: sudo gh-broker upgrade [--version <v>] [--force] [--no-reconnect] [install flags]

  1. npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@<latest|version>
  2. the newly installed binary's install, with these flags (see: gh-broker install --help)
  3. the newly installed binary's agent reconnect — "/mcp reconnect <key>" in every running
     Claude Code session

Stops at the first failed step and prints what to run to finish. --no-reconnect skips step 3.
The target must be a semantic version (--version 0.12.1); a downgrade needs --force. When the
package is installed AND deployed at the target, nothing runs unless --force. Other flags pass
through to install (e.g. --claude-config <user>:<dir>, --no-mcp-config) and are validated before
anything runs.`;

/** What `upgrade` parses to. Everything that isn't upgrade's own flag is an install flag, passed through verbatim. */
export interface UpgradeArgs {
	version?: string;
	force: boolean;
	noReconnect: boolean;
	help?: boolean;
	installFlags: string[];
}

/** A semantic version, optionally with prerelease/build parts ("0.12.1", "1.0.0-rc.1"). npm specs that aren't this (dist-tags, URLs, git and file paths) can run arbitrary code as root, so they are refused. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `upgrade` arguments; upgrade's own flags are taken out, the rest pass to install. */
export function parseUpgradeArgs(rest: string[]): UpgradeArgs {
	const args: UpgradeArgs = { force: false, noReconnect: false, installFlags: [] };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--force") args.force = true;
		else if (a === "--no-reconnect") args.noReconnect = true;
		else if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--version") {
			const v = rest[++i];
			// The version is handed to npm as a spec: anything but semver (a dist-tag, a URL, a
			// git or file path) could make npm run arbitrary code as root, so it is refused here.
			if (v === undefined || v.startsWith("-") || !SEMVER.test(v.replace(/^v/, ""))) throw new Error("--version takes a semantic version to install, e.g. --version 0.12.1");
			args.version = v.replace(/^v/, "");
		} else args.installFlags.push(a);
	}
	return args;
}

/** The (major, minor, patch) head of a semver string, or undefined when it isn't one. */
export function semverHead(v: string): [number, number, number] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether a < b in semver order ("0.9.0" < "0.10.0"); unparsable versions compare as equal. */
export function semverLess(a: string, b: string): boolean {
	const x = semverHead(a);
	const y = semverHead(b);
	if (!x || !y) return false;
	return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2];
}

/** One step `upgrade` runs, with the command an operator would run it by hand. */
export interface UpgradeStep {
	name: string;
	command: string;
}

/** Quote one argument for a shell command line (bare when it needs no quoting). */
export const shellQuote = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/**
 * The steps `upgrade` runs, in order: npm install, the new binary's install, reconnect (unless
 * `reconnect` is false). The commands are also what the failure report tells the operator to run.
 */
export function upgradeSteps(target: string, installFlags: string[], reconnect: boolean): UpgradeStep[] {
	const flags = installFlags.length ? ` ${installFlags.map(shellQuote).join(" ")}` : "";
	const steps = [
		{ name: "npm install", command: NPM_INSTALL_COMMAND.replace(/@latest$/, `@${target}`) },
		{ name: "install", command: `sudo gh-broker install${flags}` }
	];
	if (reconnect) steps.push({ name: "agent reconnect", command: "sudo gh-broker agent reconnect" });
	return steps;
}

/** The lines telling an operator step `failed` (0-based) didn't run and what to run to finish: that step's command, then the remaining ones. */
export function finishLines(steps: UpgradeStep[], failed: number, why: string): string[] {
	return [`step ${failed + 1}/${steps.length} (${steps[failed]!.name}) failed: ${why}`, "finish by running:", ...steps.slice(failed).map((s) => `  ${s.command}`)];
}

/**
 * Run one `gh-broker upgrade`. Returns the exit code; throws only on a usage error (the
 * dispatcher reports it, before anything has run), never on a failed step (that is reported and
 * returned as 1).
 */
export function upgradeCommand(rest: string[], config: ConfigLayer, d: UpgradeDeps): number {
	const args = parseUpgradeArgs(rest);
	if (args.help) {
		d.log(UPGRADE_HELP);
		return 0;
	}
	// The install flags are validated before anything runs: a misspelled flag must fail while
	// nothing has been installed yet, not after the npm step. A flag this release's parser
	// doesn't know yet passes through — the NEW binary's own parser validates everything before
	// it does anything, so an unknown flag still fails before any effect (its error just comes
	// from the child).
	let installArgs: ReturnType<typeof parseArgs> | undefined;
	try {
		installArgs = parseArgs(args.installFlags);
	} catch (err) {
		if (!/unknown flag/.test((err as Error).message)) throw new Error(`install flags: ${(err as Error).message}`);
	}
	if (installArgs?.positional.length) throw new Error(`upgrade takes only flags — "${installArgs.positional.join(" ")}" would be an install argument; pass --agent-user <name> instead`);
	const target = args.version ?? d.latestVersion() ?? "latest";
	const installed = d.installedVersion();
	const deployed = d.deployedVersion();
	if (target !== "latest" && installed !== undefined) {
		// "Already there" is judged against the deployed service, not the npm package: after a
		// run where npm succeeded but install never did, the package is current while the
		// service is not, and that run must still install.
		if (!args.force && semverLess(target, installed)) {
			d.error(`${target} is older than the installed ${installed}; not downgrading (pass --force to downgrade)`);
			return 1;
		}
		if (!args.force && installed === target && deployed === target) {
			d.log(`gh-broker ${installed} is installed and deployed; nothing to do (use --force to reinstall it)`);
			return 0;
		}
	}
	const steps = upgradeSteps(target, args.installFlags, !args.noReconnect);
	// A forced downgrade stays visible on the step line (an unforced one is refused above).
	const downgrade = args.force && target !== "latest" && installed !== undefined && semverLess(target, installed);
	for (const [i, step] of steps.entries()) {
		d.log(`==> step ${i + 1}/${steps.length}: ${step.name}${i === 0 && downgrade ? " (downgrade)" : ""}`);
		try {
			// steps[0] is always the npm install, steps[1] the new binary's install, and an
			// optional steps[2] its reconnect — see upgradeSteps.
			if (i === 0) d.npmInstall(target);
			else if (i === 1) d.runNewBinary(["install", ...args.installFlags]);
			else d.runNewBinary(["agent", "reconnect"]);
		} catch (err) {
			for (const line of finishLines(steps, i, (err as Error).message)) d.error(line);
			return 1;
		}
	}
	d.log(`✅ gh-broker is at ${target}${installed === target && deployed === target ? " (reinstalled)" : ""}${args.noReconnect ? "; reconnect skipped" : ""}`);
	return 0;
}
