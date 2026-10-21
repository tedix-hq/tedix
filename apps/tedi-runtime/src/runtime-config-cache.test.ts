import assert from "node:assert/strict";
import { RuntimeConfigCache } from "./runtime-config-cache";

const db = {} as D1Database;
type Policy = Awaited<
	ReturnType<
		typeof import("@tedix/db/queries/tedi-runtime-bootstrap").getTediRuntimePolicy
	>
>;
const row = (definition: unknown) => ({ definition }) as Policy;

const cases: [unknown, number][] = [
	[1, 1],
	[2, 2],
	[7, 7],
	[8, 8],
	[9, 8],
	[1.5, 1],
	[7.9, 7],
	[8.5, 8],
	[Number.MAX_VALUE, 8],
	[0.5, 2],
	[Number.MIN_VALUE, 2],
	[0, 2],
	[-1, 2],
	[NaN, 2],
	[Infinity, 2],
	[-Infinity, 2],
	["3", 2],
	[null, 2],
	[undefined, 2],
	[true, 2],
	[{}, 2],
];
for (const [value, expected] of cases) {
	for (const encoding of ["object", "json"] as const) {
		const definition = { workItemConcurrency: value };
		let reads = 0;
		const cache = new RuntimeConfigCache(async () => {
			reads++;
			return row(encoding === "json" ? JSON.stringify(definition) : definition);
		});
		for (let hit = 0; hit < 2; hit++) {
			const actual = await cache.getMaxConcurrentWorkItems(db, "tedi-test");
			assert.equal(actual, expected, `${encoding}: ${String(value)}`);
			assert.ok(Number.isInteger(actual) && actual >= 1 && actual <= 8);
		}
		assert.equal(reads, 1, "normalized results are cached");
	}
}

for (const definition of [
	undefined,
	null,
	"",
	"{",
	"null",
	"{}",
	{},
	"1e999",
	'{"workItemConcurrency":1e999}',
]) {
	const cache = new RuntimeConfigCache(async () => row(definition));
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 2);
}
{
	const cache = new RuntimeConfigCache(async () => null);
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 2);
}
for (const tediId of [null, undefined, ""]) {
	const cache = new RuntimeConfigCache(async () => {
		assert.fail("missing identity must not read policy");
	});
	assert.equal(await cache.getMaxConcurrentWorkItems(db, tediId), 2);
}

for (const initial of ["failure", "missing", "malformed"] as const) {
	let reads = 0;
	const cache = new RuntimeConfigCache(async () => {
		if (++reads === 1) {
			if (initial === "failure") throw new Error("transient read failure");
			return initial === "missing" ? null : row("{");
		}
		return row({ workItemConcurrency: 3.9 });
	});
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 2);
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 3);
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 3);
	assert.equal(reads, 2, `${initial}: recovery is cached`);
}

{
	let release!: (value: Policy) => void;
	let reads = 0;
	const cache = new RuntimeConfigCache(async () => {
		if (++reads === 1)
			return new Promise<Policy>((resolve) => {
				release = resolve;
			});
		return row(JSON.stringify({ workItemConcurrency: 1.9 }));
	});
	cache.modelPolicy = {
		chatModelRef: "old",
		cronModelRef: null,
		observerModelRef: null,
	};
	const pending = cache.getMaxConcurrentWorkItems(db, "tedi-test");
	cache.invalidate();
	assert.equal(cache.generation, 1);
	assert.equal(cache.modelPolicy, undefined);
	release(row({ workItemConcurrency: 7.9 }));
	const limit = await pending;
	assert.equal(limit, 1);
	assert.equal(
		1 < limit,
		false,
		"one occupied slot prevents admission after lowering",
	);
	assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi-test"), 1);
	assert.equal(reads, 2, "only the fresh normalized limit is cached");
}

console.log(
	"runtime config cache: integer limits, caching, recovery and invalidation passed",
);
