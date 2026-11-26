import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./shell";

/** One entry of the CLI's `supervisor-runners.json`, as the switches need it. */
export interface RunnerEntry {
	index: number;
	executor: string;
	organization: string;
	enabled: boolean;
	machineName?: string;
	machineWriteMode?: string;
}
type Json = string | boolean | undefined;

export function runnersPath(): string {
	return join(configDir(), "supervisor-runners.json");
}

function parse(text: string): Record<string, unknown>[] {
	try {
		const runners = (JSON.parse(text) as { runners?: unknown }).runners;
		return Array.isArray(runners) ? runners : [];
	} catch {
		return [];
	}
}

export function readRunners(): RunnerEntry[] {
	let text = "";
	try {
		text = readFileSync(runnersPath(), "utf8");
	} catch {
		return [];
	}
	return parse(text).map((runner, index) => ({
		index,
		executor: String(runner.executor ?? "?"),
		organization: String(runner.organization ?? ""),
		enabled: runner.enabled !== false,
		machineName:
			typeof runner.machineName === "string" ? runner.machineName : undefined,
		machineWriteMode:
			typeof runner.machineWriteMode === "string"
				? runner.machineWriteMode
				: undefined,
	}));
}

/**
 * The entry whose settings the machine-tools process uses, by the CLI's rule:
 * the first enabled codex runner, else the first enabled one.
 */
export function servingRunner(entries: RunnerEntry[]): RunnerEntry | undefined {
	const enabled = entries.filter((entry) => entry.enabled);
	return enabled.find((entry) => entry.executor === "codex") ?? enabled[0];
}

/**
 * Changes one field of one runner (`undefined` removes the field) and writes
 * the file the way the CLI does, with tabs. Unknown fields and key order stay.
 * Returns undefined when the file is not a runner list or has no such runner.
 */
export function editRunners(
	text: string,
	index: number,
	key: string,
	value: Json,
): string | undefined {
	let file: { runners?: unknown };
	try {
		file = JSON.parse(text);
	} catch {
		return undefined;
	}
	const runner = Array.isArray(file?.runners) ? file.runners[index] : undefined;
	if (!runner || typeof runner !== "object") return undefined;
	if (value === undefined) delete (runner as Record<string, unknown>)[key];
	else (runner as Record<string, unknown>)[key] = value;
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** Applies one change and replaces the file atomically; throws and leaves it alone otherwise. */
export function setRunnerField(index: number, key: string, value: Json): void {
	const path = runnersPath();
	const edited = editRunners(readFileSync(path, "utf8"), index, key, value);
	if (edited === undefined)
		throw new Error(`Could not change ${path}. Edit it by hand.`);
	writeFileSync(`${path}.tmp`, edited, { mode: 0o600 });
	chmodSync(`${path}.tmp`, 0o600);
	renameSync(`${path}.tmp`, path);
}
