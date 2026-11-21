/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/upgrade.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T11:28:19-08:00 (1795289299)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker upgrade` (#223): the whole upgrade under one sudo. npm installs the package, the
 * NEWLY installed binary's `install` runs as a child process (the running CLI is still the old
 * code, so it must not install itself), then `agent reconnect` sends `/mcp reconnect` to every
 * running Claude Code session the restart dropped. Each step reports; the command stops at the
 * first failure and prints which step failed and what to run to finish (the failed step's command,
 * then the remaining ones). Every effect is injected.
 */
import { NPM_INSTALL_COMMAND } from "./agents.ts";
import { reconnect, type ReconnectDeps } from "./reconnect.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** The effects `gh-broker upgrade` uses (the reconnect effects for its last step, plus its own). */
export interface UpgradeDeps extends ReconnectDeps {
	/** The version of the globally installed package, when there is one. */
	installedVersion: () => string | undefined;
	/** The version npm's registry has (undefined when it can't be reached). */
	latestVersion: () => string | undefined;
	/** Step 1: install (or upgrade) the global npm package. */
	npmInstall: (spec: string) => void;
	/** Step 2: run the newly installed binary's `install` with these flags, as a child process. */
	runNewInstall: (flags: string[]) => void;
}

export const UPGRADE_HELP = `gh-broker upgrade — the whole upgrade under one sudo.

Usage: sudo gh-broker upgrade [--version <v>] [--force] [--no-reconnect] [install flags]

  1. npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@<latest|version>
  2. the newly installed binary's install, with these flags (see: gh-broker install --help)
  3. agent reconnect — "/mcp reconnect <key>" in every running Claude Code session

Stops at the first failed step and prints what to run to finish. --no-reconnect skips
step 3. When the target version is already installed, nothing runs unless --force.
Other flags pass through to install (e.g. --claude-config <user>:<dir>, --no-mcp-config).`;

/** What `upgrade` parses to. Everything that isn't upgrade's own flag is an install flag, passed through verbatim. */
export interface UpgradeArgs {
	version?: string;
	force: boolean;
	noReconnect: boolean;
	help?: boolean;
	installFlags: string[];
}

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
			if (v === undefined || v.startsWith("-")) throw new Error("--version takes the version to install, e.g. --version 0.12.1");
			args.version = v.replace(/^v/, "");
		} else args.installFlags.push(a);
	}
	return args;
}

/** One step `upgrade` runs, with the command an operator would run it by hand. */
export interface UpgradeStep {
	name: string;
	command: string;
}

/**
 * The steps `upgrade` runs, in order: npm install, the new binary's install, reconnect (unless
 * `reconnect` is false). The commands are also what the failure report tells the operator to run.
 */
export function upgradeSteps(target: string, installFlags: string[], reconnect: boolean): UpgradeStep[] {
	const flags = installFlags.length ? ` ${installFlags.join(" ")}` : "";
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
 * dispatcher reports it), never on a failed step (that is reported and returned as 1).
 */
export function upgradeCommand(rest: string[], config: ConfigLayer, d: UpgradeDeps): number {
	const args = parseUpgradeArgs(rest);
	if (args.help) {
		d.log(UPGRADE_HELP);
		return 0;
	}
	const target = args.version ?? d.latestVersion() ?? "latest";
	const installed = d.installedVersion();
	if (installed !== undefined && installed === target && !args.force) {
		d.log(`gh-broker ${installed} is already installed; nothing to do (use --force to reinstall it)`);
		return 0;
	}
	const steps = upgradeSteps(target, args.installFlags, !args.noReconnect);
	for (const [i, step] of steps.entries()) {
		d.log(`==> step ${i + 1}/${steps.length}: ${step.name}`);
		try {
			// steps[0] is always the npm install, steps[1] the new binary's install, and an
			// optional steps[2] the reconnect — see upgradeSteps.
			if (i === 0) d.npmInstall(target);
			else if (i === 1) d.runNewInstall(args.installFlags);
			else if (reconnect([], config, d) !== 0) throw new Error("some panes were skipped (see above)");
		} catch (err) {
			for (const line of finishLines(steps, i, (err as Error).message)) d.error(line);
			return 1;
		}
	}
	d.log(`✅ gh-broker is at ${target}${installed === target ? " (reinstalled)" : ""}${args.noReconnect ? "; reconnect skipped" : ""}`);
	return 0;
}
