import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Small files the hooks write per session or per answer and never reuse later. */
const FOLDERS = ["hook-cache", "session-scopes", "feedback-outbox"];
/** The same age Claude Code uses for its own session files. */
export const OLD_FILE_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Once a day, deletes hook files older than 30 days. Nothing reads them after
 * minutes or hours, but without this they stayed forever, tens of thousands
 * of them.
 */
export function removeOldHookFiles(
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): number {
	const root = env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
	const marker = join(root, "old-files-removed");
	try {
		if (now - statSync(marker).mtimeMs < DAY_MS) return 0;
	} catch {
		/* Never run yet. */
	}
	let removed = 0;
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(marker, "");
		for (const folder of FOLDERS) {
			let names: string[];
			try {
				names = readdirSync(join(root, folder));
			} catch {
				continue;
			}
			for (const name of names) {
				const path = join(root, folder, name);
				try {
					const file = statSync(path);
					if (!file.isFile() || now - file.mtimeMs < OLD_FILE_MS) continue;
					rmSync(path);
					removed++;
				} catch {
					/* Another session removed it first. */
				}
			}
		}
	} catch {
		/* Cleanup must never fail a hook. */
	}
	return removed;
}
