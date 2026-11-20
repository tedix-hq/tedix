import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

/** The CLI's own folder: `TEDIX_CONFIG_DIR`, else `~/.tedix`. */
export function configDir(): string {
	return process.env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

export const localBin = join(homedir(), ".local", "bin");

/** The person's shell, for reading their PATH and choosing their profile file. */
export function loginShell(): string {
	try {
		return process.env.SHELL || userInfo().shell || "/bin/zsh";
	} catch {
		return "/bin/zsh";
	}
}

/**
 * An app started from the Dock gets a short PATH without the folders a
 * person's shell adds, so `claude` or `codex` would not be found. This asks
 * their login shell once for its PATH; `refreshShellPath` asks again.
 */
let shellPath: string | undefined;
export function refreshShellPath(): Promise<void> {
	if (process.platform === "win32") return Promise.resolve();
	return new Promise((resolve) => {
		execFile(
			loginShell(),
			["-lic", 'printf "<path>%s</path>" "$PATH"'],
			{ timeout: 8000, env: process.env },
			(_error, stdout) => {
				const found = /<path>([^<]*)<\/path>/.exec(String(stdout))?.[1];
				if (found) shellPath = found;
				resolve();
			},
		).stdin?.end();
	});
}

/** True when the person's own shell already has `~/.local/bin` on its PATH. */
export function shellHasLocalBin(): boolean {
	return (shellPath ?? "").split(delimiter).includes(localBin);
}

/**
 * Where commands are looked up and what started commands get as PATH: the
 * login shell's PATH, then the usual install folders, since people install
 * coding tools in different ways.
 */
export function toolPath(): string {
	const home = homedir();
	const folders = [
		localBin,
		...(shellPath ?? process.env.PATH ?? "").split(delimiter),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".npm-global", "bin"),
		join(home, ".bun", "bin"),
		"/usr/bin",
		"/bin",
	];
	return [...new Set(folders.filter(Boolean))].join(delimiter);
}

/** The full path of a command, or undefined when it is in none of the folders. */
export function findCommand(name: string): string | undefined {
	const file = process.platform === "win32" ? `${name}.exe` : name;
	for (const folder of toolPath().split(delimiter)) {
		try {
			accessSync(join(folder, file), constants.X_OK);
			return join(folder, file);
		} catch {
			/* Not here. */
		}
	}
	return undefined;
}

/** The `tedix` command: `~/.local/bin` first, where the app links its copy. */
export function findTedix(): string | undefined {
	return findCommand("tedix");
}

export interface RunResult {
	ok: boolean;
	output: string;
}
export interface RunOptions {
	env?: Record<string, string>;
	/** Called with each new line of output while the command runs. */
	onLine?: (line: string) => void;
	/** Receives a function that stops the command. */
	onStart?: (stop: () => void) => void;
	timeoutMs?: number;
}

/** Runs a command to its end with stdin closed; resolves with its exit status and combined output. */
export function run(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		let output = "";
		let done = false;
		const finish = (ok: boolean, extra = "") => {
			if (done) return;
			done = true;
			resolve({ ok, output: output || extra });
		};
		const child = spawn(command, args, {
			env: { ...process.env, ...options.env, PATH: toolPath() },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = options.timeoutMs
			? setTimeout(() => {
					output += "\nStopped: it did not finish in time.";
					child.kill();
				}, options.timeoutMs)
			: undefined;
		options.onStart?.(() => child.kill());
		const read = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (output.length < 4 * 1024 * 1024) output += text;
			if (!options.onLine) return;
			for (const line of text.split(/\r?\n/))
				if (line.trim()) options.onLine(line.trim());
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.on("error", (error) => {
			clearTimeout(timer);
			finish(false, error.message);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code === 0);
		});
	});
}

export function lastLine(output: string): string {
	return output.trim().split(/\r?\n/).at(-1) ?? "";
}
