/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/cli.ts
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T12:03:40-08:00 (1795291420)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The `gh-broker` command's dispatcher: `otp ...`, `agent ...` (including `agent reconnect`),
 * `upgrade` — and `install`, which src/bin/gh-broker.ts hands to the installer before it gets
 * here. Root check, config read and error reporting live here; the commands are in otp-cli.ts,
 * agent-cli.ts, reconnect.ts and upgrade.ts.
 */
import { otpCommand, type OtpDeps } from "./otp-cli.ts";
import { agentCommand, type AgentDeps } from "./agent-cli.ts";
import { RECONNECT_HELP, reconnect, type ReconnectDeps } from "./reconnect.ts";
import { UPGRADE_HELP, upgradeCommand, type UpgradeDeps } from "./upgrade.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** Every effect the `gh-broker` CLI uses: every command set's effects, plus the root check and the config read. */
export interface CliDeps extends OtpDeps, AgentDeps, ReconnectDeps, UpgradeDeps {
	isRoot: () => boolean;
	readConfig: () => ConfigLayer;
}

export const USAGE = `Usage: sudo gh-broker <command>

Commands:
  install [flags]            install or upgrade the broker (see: gh-broker install --help)
  upgrade [flags]            npm install, then the new binary's install with these flags, then agent reconnect
                             (--version <v> (semver), --force, --no-reconnect; other flags pass through to install)
  agent add <user>           register an agent user: group, MCP config, restart, smoke test (--no-mcp-config to skip the config)
                             --claude-config <dir>: another Claude config folder it uses outside its home (repeatable, also on sync)
  agent remove <user>        unregister an agent: empty its group, restart, MCP entry, lock state
  agent list                 each agent, its socket, and whether its MCP config points at it
  agent sync [<user>]        re-apply the MCP config for one agent or all
  agent reconnect [<user>]   send "/mcp reconnect <key>" to the agent's running Claude Code sessions (--dry-run lists them)
  otp status [<user>] [--json]
                             lock state per agent
  otp list [--json]          who is locked out now, and the command that clears each
  otp unlock <user>|--all    clear an agent's lockout and hard lock (--all: everyone)
  otp rotate                 make a new OTP seed, store it, show it once, restart the service`;

const COMMANDS: Record<string, string[]> = { otp: ["unlock", "status", "list", "rotate"], agent: ["add", "remove", "list", "sync", "reconnect"], upgrade: [] };

/**
 * @param argv  arguments after the program name, e.g. ["otp", "unlock", "repo"]
 * @param d     injected effects (see src/cli/real-deps.ts realDeps)
 * @returns the process exit code
 */
export async function runCli(argv: string[], d: CliDeps): Promise<number> {
	const [group, command, ...rest] = argv;
	if (group === undefined || group === "-h" || group === "--help" || group === "help") {
		d.log(USAGE);
		return 0;
	}
	// `upgrade` takes its flags as [command, ...rest]; the rest take a subcommand name.
	if (group !== "upgrade" && !COMMANDS[group]?.includes(command as string)) {
		d.error(`gh-broker: unknown command "${argv.join(" ")}"\n${USAGE}`);
		return 2;
	}
	// --help works without root and without a readable config: it only prints.
	if (group === "upgrade" && (command === "-h" || command === "--help")) {
		d.log(UPGRADE_HELP);
		return 0;
	}
	if (group === "agent" && command === "reconnect" && rest.some((a) => a === "-h" || a === "--help")) {
		d.log(RECONNECT_HELP);
		return 0;
	}
	const name = command === undefined ? group : `${group} ${command}`;
	if (!d.isRoot()) {
		d.error(`gh-broker ${name}: must run as root: sudo gh-broker ${name}`);
		return 1;
	}
	let config: ConfigLayer;
	try {
		config = d.readConfig();
	} catch (err) {
		d.error(`gh-broker ${name}: cannot read the broker config: ${(err as Error).message}`);
		return 1;
	}
	try {
		if (group === "upgrade") return upgradeCommand(command === undefined ? rest : [command, ...rest], config, d);
		if (group === "agent" && command === "reconnect") return reconnect(rest, config, d);
		return await (group === "otp" ? otpCommand : agentCommand)(command!, rest, config, d);
	} catch (err) {
		d.error(`gh-broker ${name}: ${(err as Error).message}`);
		return 1;
	}
}
