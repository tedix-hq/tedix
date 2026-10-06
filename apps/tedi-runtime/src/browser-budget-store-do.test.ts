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

console.log("browser-budget-store-do tests passed");
