import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { localExecutors, type LocalExecutor } from "./lane-routing";

/** What a tool is doing on this Mac now and how its tasks ended lately. */
export interface ToolLoad {
	running: number;
	waiting: number;
	recent: { finished: number; failed: number; total: number };
}

const FINISHED = new Set(["succeeded", "landed_unverified"]);
const FAILED = new Set(["failed", "expired", "rejected"]);
const RECENT_MS = 14 * 86_400_000;

/**
 * Each tool's load from this Mac's runner records: runs in progress,
 * starts in preparation, and settled results of the last 14 days. A
 * cancelled run is neither (a restart or a deferral). Read from files the
 * runners already keep; nothing is sent anywhere.
 */
export function readToolLoad(
	dispatchersDirectory: string,
	now = Date.now(),
	/** True when the path is one runner's own directory, not their parent. */
	single = false,
): Record<LocalExecutor, ToolLoad> {
	const load = Object.fromEntries(
		localExecutors.map((executor) => [
			executor,
			{ running: 0, waiting: 0, recent: { finished: 0, failed: 0, total: 0 } },
		]),
	) as Record<LocalExecutor, ToolLoad>;
	let runners: string[] = [];
	try {
		runners = single ? [""] : readdirSync(dispatchersDirectory);
	} catch {
		return load;
	}
	for (const runner of runners) {
		const directory = join(dispatchersDirectory, runner);
		let files: string[] = [];
		try {
			files = readdirSync(directory).filter(
				(name) => name.endsWith(".json") && name !== "health-source.json",
			);
		} catch {
			continue;
		}
		for (const name of files) {
			const path = join(directory, name);
			try {
				const receipt = JSON.parse(readFileSync(path, "utf8")) as {
					itemId?: string;
					session?: string;
					phase?: string;
					outcome?: string;
				};
				const executor = receipt.session?.split(":")[0] as LocalExecutor;
				if (!receipt.itemId || !load[executor]) continue;
				const tool = load[executor];
				if (receipt.phase === "running" || receipt.phase === "admitted")
					tool.running++;
				else if (receipt.phase === "preparing") tool.waiting++;
				if (
					receipt.outcome &&
					(FINISHED.has(receipt.outcome) || FAILED.has(receipt.outcome)) &&
					now - statSync(path).mtimeMs <= RECENT_MS
				) {
					tool.recent.total++;
					if (FINISHED.has(receipt.outcome)) tool.recent.finished++;
					else tool.recent.failed++;
				}
			} catch {}
		}
	}
	return load;
}
