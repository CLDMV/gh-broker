import { stdin, stdout } from "node:process";

// Control codes, by number, so no literal control characters live in this file.
const LF = 10; // Enter
const CR = 13; // Enter
const EOT = 4; // Ctrl-D
const ETX = 3; // Ctrl-C
const DEL = 127; // Backspace
const BS = 8; // Backspace

/**
 * Raw-mode line reader. `echo` controls whether typed characters are shown:
 * visible prompts echo them, secret prompts don't. Handles Enter, Ctrl-C (abort),
 * Ctrl-D, and Backspace. Falls back to non-raw when stdin isn't a TTY.
 */
function readLine(question, echo) {
	return new Promise((resolve, reject) => {
		stdout.write(question);
		let input = "";
		const onData = (chunk) => {
			const s = chunk.toString("utf8");
			for (const ch of s) {
				const code = ch.charCodeAt(0);
				if (code === LF || code === CR || code === EOT) {
					cleanup();
					stdout.write("\n");
					return resolve(input.trim());
				}
				if (code === ETX) {
					cleanup();
					stdout.write("\n");
					return reject(new Error("aborted"));
				}
				if (code === DEL || code === BS) {
					if (input.length > 0) {
						input = input.slice(0, -1);
						if (echo) stdout.write("\b \b");
					}
					continue;
				}
				input += ch;
				if (echo) stdout.write(ch);
			}
		};
		const cleanup = () => {
			stdin.removeListener("data", onData);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
		};
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
	});
}

/** Ask a visible question; typed characters are echoed. Returns the trimmed answer. */
export function promptLine(question) {
	return readLine(question, true);
}

/** Ask for a secret; typed characters are NOT echoed. Never prints the value. */
export function promptHidden(question) {
	return readLine(question, false);
}

/** Yes/no confirmation. Defaults to no unless the answer starts with y/Y. */
export async function confirm(question) {
	const a = await promptLine(`${question} [y/N] `);
	return /^y(es)?$/i.test(a);
}
