import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
	BrowserBudgetExceededError,
	browserBudgetDay,
	DoBrowserBudgetStore,
} from "./browser-budget-store-do";

function makeRunner() {
	const db = new Database(":memory:");
	return {
		sql<T = Record<string, string | number | boolean | null>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			const sql = strings.reduce(
				(text, part, index) => text + part + (index < values.length ? "?" : ""),
				"",
			);
			return db.query(sql).all(...values) as T[];
		},
	};
}

const dayOne = new Date("2026-07-16T12:00:00.000Z");
const dayTwo = new Date("2026-07-17T00:00:00.000Z");
assert.equal(browserBudgetDay(dayOne), "2026-07-16");

{
	const store = new DoBrowserBudgetStore(makeRunner());
	assert.deepEqual(store.status(2, dayOne), {
		day: "2026-07-16",
		limit: 2,
		remaining: 2,
		used: 0,
	});
	assert.equal(store.consume(2, dayOne).used, 1);
	assert.deepEqual(store.consume(2, dayOne), {
		day: "2026-07-16",
		limit: 2,
		remaining: 0,
		used: 2,
	});
	assert.throws(
		() => store.consume(2, dayOne),
		(error) =>
			error instanceof BrowserBudgetExceededError &&
			error.usage.used === 2 &&
			error.usage.remaining === 0,
	);
	assert.equal(store.consume(2, dayTwo).used, 1, "UTC day resets usage");
}

{
	const store = new DoBrowserBudgetStore(makeRunner());
	assert.throws(
		() => store.consume(0, dayOne),
		(error) =>
			error instanceof BrowserBudgetExceededError && error.usage.limit === 0,
		"zero budget fails closed",
	);
}

// Persistent-window accounting: a live session accrues to now, an idle one
// settles at last-seen + keep-alive, and a closed one ends at its close.
{
	const store = new DoBrowserBudgetStore(makeRunner());
	const t0 = Date.parse("2026-07-16T12:00:00.000Z");
	store.observePersistentWindow(
		{ sessionId: "s1", startedAt: t0, keepAliveMs: 600_000 },
		new Date(t0),
	);
	store.observePersistentWindow(
		{ sessionId: "s1", startedAt: t0, keepAliveMs: 600_000 },
		new Date(t0 + 90_000),
	);
	assert.deepEqual(store.persistentMinutes(new Date(t0 + 90_000)), {
		day: "2026-07-16",
		minutes: 2,
		ms: 90_000,
	});
	// After s1's keep-alive lapses a later observation settles it at
	// last_seen + 600s = t0 + 690s (11.5 min, rounds up per session).
	const t1 = t0 + 90_000 + 600_000 + 1_000;
	store.observePersistentWindow(
		{ sessionId: "s2", startedAt: t1, keepAliveMs: 60_000 },
		new Date(t1),
	);
	assert.deepEqual(store.persistentMinutes(new Date(t1)).minutes, 12);
	// An explicit close ends s2's window at the close, before keep-alive.
	store.endPersistentWindow("s2", new Date(t1 + 30_000));
	const settled = store.persistentMinutes(new Date(t1 + 30_000));
	assert.equal(settled.minutes, 13);
	assert.equal(settled.ms, 690_000 + 30_000);
}

// The idle tail spans UTC midnight, survives a store reconstruction, and is
// capped at expiry without another browser call to settle it.
{
	const runner = makeRunner();
	const start = Date.parse("2026-07-16T23:59:30.000Z");
	new DoBrowserBudgetStore(runner).observePersistentWindow(
		{ sessionId: "overnight", startedAt: start, keepAliveMs: 120_000 },
		new Date(start),
	);
	const store = new DoBrowserBudgetStore(runner);
	assert.equal(store.persistentMinutes(new Date(start + 29_999)).ms, 29_999);
	assert.deepEqual(store.persistentMinutes(new Date(start + 300_000)), {
		day: "2026-07-17",
		minutes: 2,
		ms: 90_000,
	});
	store.endPersistentWindow("overnight", new Date(start + 300_000));
	assert.equal(store.persistentMinutes(new Date(start + 600_000)).ms, 90_000);
}

console.log("browser-budget-store-do tests passed");
