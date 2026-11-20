import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Adds one line to `tedix.log` in the app's logs folder, so a failed sign-in
 * or update can be traced afterwards. Never pass tokens, codes or keys.
 */
export function log(line: string): void {
	try {
		const folder = app.getPath("logs");
		mkdirSync(folder, { recursive: true });
		const file = join(folder, "tedix.log");
		try {
			if (statSync(file).size > 1_000_000) renameSync(file, `${file}.old`);
		} catch {
			/* No log yet. */
		}
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* A log that cannot be written must not stop the app. */
	}
}
