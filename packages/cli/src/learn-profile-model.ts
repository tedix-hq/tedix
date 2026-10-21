import { type RunModel, codexModel, onPath } from "./learn-analyze";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Models, metered
// ---------------------------------------------------------------------------

export interface Meter {
	calls: number;
	cached: number;
	failed: number;
	ms: number;
	costUsd: number;
}

export function newMeter(): Meter {
	return { calls: 0, cached: 0, failed: 0, ms: 0, costUsd: 0 };
}

/**
 * The member's own `claude` (haiku), headless and isolated like the other
 * learn steps, with its JSON envelope read for the cost of the call.
 */
export function claudeHaiku(meter: Meter): RunModel {
	return (prompt) =>
		new Promise((resolve, reject) => {
			const started = Date.now();
			const child = spawn(
				"claude",
				[
					"-p",
					"--model",
					"haiku",
					"--no-session-persistence",
					"--output-format",
					"json",
					"--tools",
					"",
					"--setting-sources",
					"project",
				],
				{ cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
			);
			let out = "";
			const timer = setTimeout(() => child.kill(), 300_000);
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				meter.calls++;
				meter.ms += Date.now() - started;
				try {
					const envelope = JSON.parse(out);
					meter.costUsd += Number(envelope.total_cost_usd ?? 0);
					if (code === 0 && !envelope.is_error)
						return resolve(String(envelope.result ?? ""));
				} catch {
					/* Not an envelope. */
				}
				meter.failed++;
				reject(new Error(`claude exited ${code}`));
			});
			child.stdin.end(prompt);
		});
}

function meteredCodex(meter: Meter): RunModel {
	return async (prompt) => {
		const started = Date.now();
		try {
			return await codexModel(prompt);
		} catch (error) {
			meter.failed++;
			throw error;
		} finally {
			meter.calls++;
			meter.ms += Date.now() - started;
		}
	};
}

export function profileModel(
	meter: Meter,
	has: (command: string) => boolean = (c) => onPath(c),
): { name: string; run: RunModel } | null {
	if (has("claude")) return { name: "claude haiku", run: claudeHaiku(meter) };
	if (has("codex"))
		return { name: "codex (low effort)", run: meteredCodex(meter) };
	return null;
}

export function parseJson(raw: string, open: "[" | "{"): any {
	const close = open === "[" ? "]" : "}";
	const start = raw.indexOf(open);
	const end = raw.lastIndexOf(close);
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
}

export async function pool<T>(
	items: T[],
	size: number,
	work: (item: T) => Promise<void>,
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await work(items[next++]!);
		}),
	);
}
