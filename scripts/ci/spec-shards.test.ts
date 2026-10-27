import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	parseSpecShard,
	shardSpecs,
} from "../../apps/os/browser-tests/spec-shards";

const manifest = JSON.parse(
	readFileSync(new URL("../../apps/os/package.json", import.meta.url), "utf8"),
);
const shards: Record<string, number> = manifest.tedixCi.testScriptShards;

test("spec shards cover a suite exactly once and in every count", () => {
	const specs = Array.from({ length: 10 }, (_, index) => `s${index}`);
	for (const count of [1, 2, 3, 8]) {
		const run: string[] = [];
		for (let shard = 1; shard <= count; shard++)
			run.push(...shardSpecs(specs, `${shard}/${count}`));
		expect([...run].sort()).toEqual([...specs].sort());
		expect(new Set(run).size).toBe(run.length);
	}
});

test("malformed shard values fail rather than silently miss specs", () => {
	const overflow = "9".repeat(309);
	for (const value of [
		"",
		"0/2",
		"3/2",
		"1/no",
		"1/0",
		"1.5/2",
		"1/",
		"9007199254740992/9007199254740992",
		"1/9007199254740992",
		`${overflow}/${overflow}`,
	])
		expect(() => parseSpecShard(value)).toThrow("Invalid spec shard");
});

test("the long browser suites each run as two CI shards", () => {
	for (const name of [
		"deck",
		"feed-deck",
		"viewport",
		"shell",
		"work-iphone",
		"settings",
	])
		expect(shards[`test:browser:${name}`]).toBe(2);
});

test("each sharded run-specs suite assigns every spec to exactly one shard", () => {
	for (const [script, count] of Object.entries(shards)) {
		const command: string = manifest.scripts[script];
		if (!command.includes("run-specs.ts")) continue;
		const specs = command
			.split(/\s+/)
			.filter((part) => part.endsWith(".spec.ts"));
		// A spec listed twice would run twice even without sharding.
		expect(new Set(specs).size).toBe(specs.length);
		expect(specs.length).toBeGreaterThanOrEqual(count);
		const run: string[] = [];
		for (let shard = 1; shard <= count; shard++)
			run.push(...shardSpecs(specs, `${shard}/${count}`));
		expect(run.length).toBe(specs.length);
		expect(new Set(run).size).toBe(run.length);
	}
});

test("every multi-shard OS script's files accept --shard, or vitest does it", () => {
	const osRoot = new URL("../../apps/os/", import.meta.url);
	for (const [script, count] of Object.entries(shards)) {
		if (count < 2) continue;
		const command: string = manifest.scripts[script];
		if (/\bvp test\b/.test(command)) continue;
		const files = command
			.split(/\s+/)
			.filter((part) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(part));
		expect(files.length).toBeGreaterThan(0);
		expect(
			files.some((file) =>
				readFileSync(new URL(file, osRoot), "utf8").includes('"--shard"'),
			),
		).toBe(true);
	}
});
