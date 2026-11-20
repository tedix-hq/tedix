import { readdirSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

const workItemId = z.uuid();

// Only filenames matter. The dispatcher reads the canonical Work Item using
// its own organization and runs the same checks as on a scheduled pass.
export function dispatchRequestsDirectory(dispatcherDirectory: string) {
	return join(dispatcherDirectory, "dispatch-requests");
}

/**
 * Resolves with the next request in the folder that is not in `seen`. The file
 * stays where it is: the caller removes it once a runner has dealt with it.
 */
export function waitForDispatchRequest(
	directory: string,
	delay: number,
	signal: AbortSignal,
	seen: ReadonlySet<string> = new Set(),
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(undefined);
		let watcher: ReturnType<typeof watch> | undefined;
		const finish = (id?: string) => {
			clearTimeout(timer);
			clearInterval(poll);
			watcher?.close();
			signal.removeEventListener("abort", abort);
			resolve(id);
		};
		const abort = () => finish();
		const check = () => {
			try {
				const id = readdirSync(directory).find(
					(id) => !seen.has(id) && workItemId.safeParse(id).success,
				);
				if (id) finish(id);
			} catch {
				// A missing request directory only disables the early wake.
			}
		};
		const timer = setTimeout(finish, delay);
		// The watcher can miss a file written while it is still being set up
		// or while the machine is busy, so the directory is also read on a timer.
		const poll = setInterval(check, 250);
		signal.addEventListener("abort", abort, { once: true });
		try {
			watcher = watch(directory, check);
			watcher.on("error", () => watcher?.close());
		} catch {
			// The timer still runs if the filesystem cannot be watched.
		}
		check();
	});
}

/**
 * Hands every request in the folder to `start` until the signal aborts. A
 * request file is removed only after `start` reports that the runner dealt
 * with it; one it left for the next runner stays in the folder, and this
 * process does not read it again.
 */
export async function serveDispatchRequests(
	directory: string,
	signal: AbortSignal,
	start: (workItemId: string) => Promise<boolean>,
) {
	const seen = new Set<string>();
	while (!signal.aborted) {
		const id = await waitForDispatchRequest(directory, 60_000, signal, seen);
		if (!id || signal.aborted) continue;
		seen.add(id);
		void start(id).then((handled) => {
			if (!handled) return;
			rmSync(join(directory, id), { force: true });
			seen.delete(id);
		});
	}
}
