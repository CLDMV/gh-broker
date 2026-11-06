/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/cli.ts
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-06T06:12:13-08:00 (1793974333)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The `gh-broker` command's dispatcher: `otp ...` and `agent ...` (and `install`, which
 * src/bin/gh-broker.ts hands to the installer before it gets here). Root check, config read and error
 * reporting live here; the commands are in otp-cli.ts and agent-cli.ts.
 */
import { otpCommand, type OtpDeps } from "./otp-cli.ts";
import { agentCommand, type AgentDeps } from "./agent-cli.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** Every effect the `gh-broker` CLI uses: both command sets' effects, plus the root check and the config read. */
export interface CliDeps extends OtpDeps, AgentDeps {
	isRoot: () => boolean;
	readConfig: () => ConfigLayer;
}

export const USAGE = `Usage: sudo gh-broker <command>

Commands:
  install [flags]            install or upgrade the broker (see: gh-broker install --help)
  agent add <user>           register an agent user: group, MCP config, restart, smoke test (--no-mcp-config to skip the config)
                             --claude-config <dir>: another Claude config folder it uses outside its home (repeatable, also on sync)
  agent remove <user>        unregister an agent: empty its group, restart, MCP entry, lock state
  agent list                 each agent, its socket, and whether its MCP config points at it
  agent sync [<user>]        re-apply the MCP config for one agent or all
  otp status [<user>] [--json]
                             lock state per agent
  otp list [--json]          who is locked out now, and the command that clears each
  otp unlock <user>|--all    clear an agent's lockout and hard lock (--all: everyone)
  otp rotate                 make a new OTP seed, store it, show it once, restart the service`;

const COMMANDS: Record<string, string[]> = { otp: ["unlock", "status", "list", "rotate"], agent: ["add", "remove", "list", "sync"] };

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
	if (!COMMANDS[group]?.includes(command as string)) {
		d.error(`gh-broker: unknown command "${argv.join(" ")}"\n${USAGE}`);
		return 2;
	}
	if (!d.isRoot()) {
		d.error(`gh-broker ${group} ${command}: must run as root: sudo gh-broker ${group} ${command}`);
		return 1;
	}
	let config: ConfigLayer;
	try {
		config = d.readConfig();
	} catch (err) {
		d.error(`gh-broker ${group} ${command}: cannot read the broker config: ${(err as Error).message}`);
		return 1;
	}
	try {
		return await (group === "otp" ? otpCommand : agentCommand)(command!, rest, config, d);
	} catch (err) {
		d.error(`gh-broker ${group} ${command}: ${(err as Error).message}`);
		return 1;
	}
}
