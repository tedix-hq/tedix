/**
 * Persistent REPL input history — Claude-Code-style ↑/↓ recall that survives
 * restarts. One JSON-encoded string per line in `~/.tedix/history` (or
 * `$TEDIX_CONFIG_DIR/history`), so multi-line composed inputs round-trip.
 * Fail-soft everywhere: a missing/corrupt file yields an empty history and a
 * failed append is ignored — history must never break the REPL.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Max entries retained on load (the file itself is append-only). */
const HISTORY_LIMIT = 1_000;

export function replHistoryPath(): string {
	const dir = process.env.TEDIX_CONFIG_DIR ?? join(homedir(), ".tedix");
	return join(dir, "history");
}

/** Load persisted history, oldest first, capped at {@link HISTORY_LIMIT}. */
export function loadReplHistory(): string[] {
	try {
		const raw = readFileSync(replHistoryPath(), "utf8");
		const entries: string[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (typeof parsed === "string" && parsed.length > 0) {
					entries.push(parsed);
				}
			} catch {
				// Tolerate a hand-edited plain-text line.
				entries.push(line);
			}
		}
		return entries.slice(-HISTORY_LIMIT);
	} catch {
		return [];
	}
}

export interface HistoryMatch {
	index: number;
	value: string;
}

/**
 * Find the previous case-insensitive history entry containing `query`.
 *
 * `beforeIndex` is exclusive, so feeding the returned index back into the
 * next call implements repeated Ctrl-R without wrapping around. An empty
 * query deliberately matches every entry and recalls the newest command.
 */
export function findPreviousHistoryMatch(
	history: string[],
	query: string,
	beforeIndex = history.length,
): HistoryMatch | null {
	const needle = query.toLocaleLowerCase();
	const start = Math.min(Math.max(0, beforeIndex), history.length) - 1;
	for (let index = start; index >= 0; index--) {
		const value = history[index];
		if (value?.toLocaleLowerCase().includes(needle)) {
			return { index, value };
		}
	}
	return null;
}

/** Append one submitted input to the history file. Never throws. */
export function appendReplHistory(entry: string): void {
	if (!entry.trim()) return;
	try {
		const path = replHistoryPath();
		mkdirSync(join(path, ".."), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// fail-soft — history persistence is best-effort
	}
}
