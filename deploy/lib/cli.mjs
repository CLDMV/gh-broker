/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/cli.mjs
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T09:12:00-08:00 (1793639520)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The `gh-broker` command's dispatcher: `otp ...` and `agent ...` (and `install`, which
 * deploy/cli.mjs hands to the installer before it gets here). Root check, config read and error
 * reporting live here; the commands are in otp-cli.mjs and agent-cli.mjs.
 */
import { otpCommand } from "./otp-cli.mjs";
import { agentCommand } from "./agent-cli.mjs";

export const USAGE = `Usage: sudo gh-broker <command>

Commands:
  install [flags]            install or upgrade the broker (see: gh-broker install --help)
  agent add <user>           register an agent user: group, MCP config, restart, smoke test (--no-mcp-config to skip the config)
  agent remove <user>        unregister an agent: empty its group, restart, MCP entry, lock state
  agent list                 each agent, its socket, and whether its MCP config points at it
  agent sync [<user>]        re-apply the MCP config for one agent or all
  otp status [<user>] [--json]
                             lock state per agent
  otp list [--json]          who is locked out now, and the command that clears each
  otp unlock <user>|--all    clear an agent's lockout and hard lock (--all: everyone)
  otp rotate                 make a new OTP seed, store it, show it once, restart the service`;

const COMMANDS = { otp: ["unlock", "status", "list", "rotate"], agent: ["add", "remove", "list", "sync"] };

/**
 * @param {string[]} argv  arguments after the program name, e.g. ["otp", "unlock", "repo"]
 * @param {object} d       injected effects (see deploy/cli.mjs realDeps)
 * @returns {Promise<number>} the process exit code
 */
export async function runCli(argv, d) {
	const [group, command, ...rest] = argv;
	if (group === undefined || group === "-h" || group === "--help" || group === "help") {
		d.log(USAGE);
		return 0;
	}
	if (!COMMANDS[group]?.includes(command)) {
		d.error(`gh-broker: unknown command "${argv.join(" ")}"\n${USAGE}`);
		return 2;
	}
	if (!d.isRoot()) {
		d.error(`gh-broker ${group} ${command}: must run as root: sudo gh-broker ${group} ${command}`);
		return 1;
	}
	let config;
	try {
		config = d.readConfig();
	} catch (err) {
		d.error(`gh-broker ${group} ${command}: cannot read the broker config: ${err.message}`);
		return 1;
	}
	try {
		return await (group === "otp" ? otpCommand : agentCommand)(command, rest, config, d);
	} catch (err) {
		d.error(`gh-broker ${group} ${command}: ${err.message}`);
		return 1;
	}
}
