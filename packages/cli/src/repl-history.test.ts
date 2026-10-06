import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendReplHistory,
	findPreviousHistoryMatch,
	loadReplHistory,
	replHistoryPath,
} from "./repl-history";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tedix-history-"));
	prevConfigDir = process.env.TEDIX_CONFIG_DIR;
	process.env.TEDIX_CONFIG_DIR = dir;
});

describe("findPreviousHistoryMatch", () => {
	const history = [
		"list runs",
		"Deploy staging",
		"inspect run abc",
		"deploy production",
	];

	test("searches newest-first and case-insensitively", () => {
		expect(findPreviousHistoryMatch(history, "DEPLOY")).toEqual({
			index: 3,
			value: "deploy production",
		});
	});

	test("repeated search continues before the previous match", () => {
		const latest = findPreviousHistoryMatch(history, "deploy");
		expect(findPreviousHistoryMatch(history, "deploy", latest?.index)).toEqual({
			index: 1,
			value: "Deploy staging",
		});
	});

	test("blank search recalls newest and exhaustion returns null", () => {
		expect(findPreviousHistoryMatch(history, "")?.value).toBe(
			"deploy production",
		);
		expect(findPreviousHistoryMatch(history, "deploy", 1)).toBeNull();
	});
});

afterEach(() => {
	if (prevConfigDir === undefined) delete process.env.TEDIX_CONFIG_DIR;
	else process.env.TEDIX_CONFIG_DIR = prevConfigDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("repl-history", () => {
	test("missing file loads as empty history", () => {
		expect(loadReplHistory()).toEqual([]);
	});

	test("append then load round-trips, including multi-line entries", () => {
		appendReplHistory("list all skills from tedix org");
		appendReplHistory("line one\nline two");
		expect(loadReplHistory()).toEqual([
			"list all skills from tedix org",
			"line one\nline two",
		]);
	});

	test("blank entries are not persisted", () => {
		appendReplHistory("   ");
		expect(loadReplHistory()).toEqual([]);
	});

	test("tolerates hand-edited plain-text lines", () => {
		writeFileSync(replHistoryPath(), 'plain old line\n"json line"\n', "utf8");
		expect(loadReplHistory()).toEqual(["plain old line", "json line"]);
	});

	test("file stores one JSON string per line", () => {
		appendReplHistory("a");
		appendReplHistory("b");
		expect(readFileSync(replHistoryPath(), "utf8")).toBe('"a"\n"b"\n');
	});
});
