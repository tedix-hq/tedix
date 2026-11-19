import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** A detached worker must not lose its output destination with its parent. */
export function laneOutput(path: string, receive: (chunk: Buffer) => void) {
	const fd = openSync(path, "wx+", 0o600);
	let offset = 0;
	const drain = () => {
		const buffer = Buffer.alloc(65536);
		let size: number;
		while ((size = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
			offset += size;
			receive(Buffer.from(buffer.subarray(0, size)));
		}
	};
	const timer = setInterval(drain, 100);
	return {
		fd,
		close() {
			clearInterval(timer);
			try {
				drain();
			} finally {
				closeSync(fd);
			}
		},
	};
}

const TURN_OUTPUT = /^(?:stdout|stderr)-(\d+)\.log$/;

/** The highest turn number with an output file in this folder, if any. */
export function lastLaneOutputTurn(directory: string): number | undefined {
	let last: number | undefined;
	let names: string[] = [];
	try {
		names = readdirSync(directory);
	} catch {
		// No folder yet means no turn has written there.
	}
	for (const name of names) {
		const turn = Number(TURN_OUTPUT.exec(name)?.[1] ?? Number.NaN);
		if (Number.isSafeInteger(turn) && (last === undefined || turn > last))
			last = turn;
	}
	return last;
}

/**
 * One Attempt launches several turns into the same folder: a follow-up, an
 * answer, or a resume after a runner restart. Each gets the next free number,
 * so an earlier turn's output is never reopened, overwritten or removed.
 */
export function laneTurnOutputPaths(directory: string) {
	const turn = (lastLaneOutputTurn(directory) ?? -1) + 1;
	return {
		turn,
		stdout: join(directory, `stdout-${turn}.log`),
		stderr: join(directory, `stderr-${turn}.log`),
	};
}

/** Opens the next turn's output files; both are created, never reused. */
export function laneTurnOutput(
	directory: string,
	receiveStdout: (chunk: Buffer) => void,
	receiveStderr: (chunk: Buffer) => void,
) {
	const paths = laneTurnOutputPaths(directory);
	const stdout = laneOutput(paths.stdout, receiveStdout);
	try {
		return {
			turn: paths.turn,
			stdout,
			stderr: laneOutput(paths.stderr, receiveStderr),
		};
	} catch (error) {
		stdout.close();
		throw error;
	}
}
