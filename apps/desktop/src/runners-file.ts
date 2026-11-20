import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
 * Changes one field of one runner the way a person would, one line at a time,
 * so unknown fields, key order and the tab formatting stay as the CLI wrote
 * them (`undefined` removes the field). Returns undefined when the result
 * would not be exactly the old content plus that one change.
 */
export function editRunners(
	text: string,
	index: number,
	key: string,
	value: Json,
): string | undefined {
	const lines = text.split("\n");
	const starts = lines.flatMap((line, at) => (line === "\t\t{" ? [at] : []));
	const start = starts[index];
	if (start === undefined) return undefined;
	const end = lines.findIndex(
		(line, at) => at > start && line.startsWith("\t\t}"),
	);
	if (end < 0) return undefined;
	const prefix = `\t\t\t${JSON.stringify(key)}: `;
	const at = lines.findIndex(
		(line, i) => i > start && i < end && line.startsWith(prefix),
	);
	if (at >= 0 && value !== undefined) {
		lines[at] =
			prefix + JSON.stringify(value) + (lines[at]!.endsWith(",") ? "," : "");
	} else if (at >= 0) {
		lines.splice(at, 1);
		if (at === end - 1 && at - 1 > start)
			lines[at - 1] = lines[at - 1]!.replace(/,$/, "");
	} else if (value !== undefined) {
		if (end - 1 > start) lines[end - 1] += ",";
		lines.splice(end, 0, prefix + JSON.stringify(value));
	}
	const edited = lines.join("\n");

	const expected = parse(text);
	if (!expected[index]) return undefined;
	if (value === undefined) delete expected[index][key];
	else expected[index][key] = value;
	return isDeepStrictEqual(parse(edited), expected) ? edited : undefined;
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
