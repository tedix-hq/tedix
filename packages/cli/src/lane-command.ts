import { execFile, type ExecFileOptions } from "node:child_process";

/** Keep process deadlines off the event loop that renews Work leases. */
export function laneCommand(
	command: string,
	args: string[],
	options: ExecFileOptions = {},
) {
	return new Promise<{
		status: number | null;
		signal: NodeJS.Signals | null;
		error?: NodeJS.ErrnoException;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		const child = execFile(
			command,
			args,
			{ ...options, encoding: "utf8" },
			(error, stdout, stderr) => {
				const failure = error as
					| (NodeJS.ErrnoException & {
							killed?: boolean;
							signal?: NodeJS.Signals;
					  })
					| null;
				resolve({
					status: error
						? typeof error.code === "number"
							? error.code
							: null
						: 0,
					signal: failure?.signal ?? null,
					error:
						failure && (typeof failure.code === "string" || failure.killed)
							? Object.assign(
									failure,
									failure.killed && failure.code == null
										? { code: "ETIMEDOUT" }
										: {},
								)
							: undefined,
					stdout: String(stdout),
					stderr: String(stderr),
				});
			},
		);
		child.stdin?.end();
	});
}
