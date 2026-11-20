import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The CLI's own folder: `TEDIX_CONFIG_DIR`, else `~/.tedix`. */
export function configDir(): string {
	return process.env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

const localBin = join(homedir(), ".local", "bin");

/** The `tedix` command on PATH or in `~/.local/bin`. The app never bundles one. */
export function findTedix(): string | undefined {
	const name = process.platform === "win32" ? "tedix.exe" : "tedix";
	const folders = [...(process.env.PATH ?? "").split(delimiter), localBin];
	for (const folder of folders) {
		if (!folder) continue;
		try {
			accessSync(join(folder, name), constants.X_OK);
			return join(folder, name);
		} catch {
			/* Not here. */
		}
	}
	return undefined;
}

/** Runs a command to its end; resolves with its exit status and combined output. */
export function run(
	command: string,
	args: string[],
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				env: {
					...process.env,
					PATH: `${localBin}${delimiter}${process.env.PATH ?? ""}`,
				},
				maxBuffer: 32 * 1024 * 1024,
			},
			(error, stdout, stderr) =>
				resolve({
					ok: !error,
					output: `${stdout}${stderr}` || (error?.message ?? ""),
				}),
		).stdin?.end();
	});
}

export function lastLine(output: string): string {
	return output.trim().split(/\r?\n/).at(-1) ?? "";
}
