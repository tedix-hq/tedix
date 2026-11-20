import { readdirSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

const workItemId = z.uuid();

// Only filenames matter. The dispatcher reads the canonical Work Item using
// its own organization and runs the same checks as on a scheduled pass.
export function dispatchRequestsDirectory(dispatcherDirectory: string) {
	return join(dispatcherDirectory, "dispatch-requests");
}

export function waitForDispatchRequest(
	directory: string,
	delay: number,
	signal: AbortSignal,
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
					(id) => workItemId.safeParse(id).success,
				);
				if (!id) return;
				unlinkSync(join(directory, id));
				finish(id);
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
