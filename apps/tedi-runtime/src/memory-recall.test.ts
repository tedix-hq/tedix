/**
 * Bounded long-term memory recall for the brain-digest addendum.
 *
 * Run: `bun run src/memory-recall.test.ts`
 */

import assert from "node:assert/strict";
import type { MemorySearchResult } from "./brain/platform-client";
import {
	isTrivialRecallQuery,
	MEMORY_RECALL_BUDGET_MS,
	recallLongTermMemoryBlock,
} from "./memory-recall";

// ── Skip rule ────────────────────────────────────────────────────────────────
for (const trivial of [
	"",
	"   ",
	"ok",
	"OK.",
	"okay!",
	"Continue",
	"continue please",
	"please continue",
	"yes",
	"Thanks!",
	"thank you",
	"go ahead",
	"Make it happen.",
	"2",
	"12",
	"1 3",
	"👍",
	"...",
]) {
	assert.equal(isTrivialRecallQuery(trivial), true, `trivial: ${trivial}`);
}
for (const meaningful of [
	"ok, but use the Q3 numbers",
	"continue with the invoice for Acme",
	"yes, send it to Maria",
	"what did we decide about pricing?",
	"thanks, now draft the reply",
	"Q3",
	"2024 revenue",
	"Maria",
	"go ahead and email the supplier",
]) {
	assert.equal(
		isTrivialRecallQuery(meaningful),
		false,
		`meaningful: ${meaningful}`,
	);
}

assert.equal(MEMORY_RECALL_BUDGET_MS, 2_000);

const result: MemorySearchResult = {
	results: [
		{ factId: "f1", score: 0.9, fact: { summary: "Acme pays net 30" } },
		{ factId: "f2", score: 0.8 },
	],
};

// ── Trivial message never searches ───────────────────────────────────────────
{
	let calls = 0;
	const out = await recallLongTermMemoryBlock({
		userText: "continue",
		search: async () => {
			calls++;
			return result;
		},
	});
	assert.equal(calls, 0);
	assert.equal(out.outcome, "skipped_trivial");
	assert.equal(out.block, "");
}

// ── Completed recall renders the block ───────────────────────────────────────
{
	const out = await recallLongTermMemoryBlock({
		userText: "What are Acme's payment terms?",
		search: async (_query, limit) => {
			assert.equal(limit, 6);
			return result;
		},
	});
	assert.equal(out.outcome, "completed");
	assert.equal(out.factCount, 1);
	assert.match(out.block, /# Relevant Long-Term Memory/);
	assert.match(out.block, /Acme pays net 30/);
}

// ── No platform, failure ─────────────────────────────────────────────────────
{
	const unavailable = await recallLongTermMemoryBlock({
		userText: "What are Acme's payment terms?",
		search: async () => null,
	});
	assert.equal(unavailable.outcome, "unavailable");
	assert.equal(unavailable.block, "");

	const originalError = console.error;
	console.error = () => {};
	try {
		const failed = await recallLongTermMemoryBlock({
			userText: "What are Acme's payment terms?",
			search: async () => {
				throw new Error("rpc down");
			},
		});
		assert.equal(failed.outcome, "failed");
		assert.equal(failed.block, "");
		const thrownSync = await recallLongTermMemoryBlock({
			userText: "What are Acme's payment terms?",
			search: () => {
				throw new Error("sync throw");
			},
		});
		assert.equal(thrownSync.outcome, "failed");
	} finally {
		console.error = originalError;
	}
}

// ── Cap: a slow search resolves at the budget without the memory block ───────
{
	const started = performance.now();
	let lateResolve: ((value: MemorySearchResult) => void) | undefined;
	const out = await recallLongTermMemoryBlock({
		userText: "What are Acme's payment terms?",
		search: () =>
			new Promise<MemorySearchResult>((resolve) => {
				lateResolve = resolve;
			}),
		budgetMs: 50,
	});
	const elapsed = performance.now() - started;
	assert.equal(out.outcome, "timed_out");
	assert.equal(out.block, "");
	assert.ok(elapsed < 1_000, `resolved in ${elapsed}ms`);
	lateResolve?.(result); // settles later without affecting the turn
}

// ── Cap at the default 2 s budget with a 10 s fake search ────────────────────
{
	const started = performance.now();
	const out = await recallLongTermMemoryBlock({
		userText: "What are Acme's payment terms?",
		search: () =>
			new Promise<MemorySearchResult>((resolve) => {
				const timer = setTimeout(() => resolve(result), 10_000);
				(timer as { unref?: () => void }).unref?.();
			}),
	});
	const elapsed = performance.now() - started;
	assert.equal(out.outcome, "timed_out");
	assert.equal(out.block, "");
	assert.ok(elapsed >= 1_900 && elapsed < 3_000, `resolved in ${elapsed}ms`);
}

// ── A late rejection after the cap is swallowed, not unhandled ───────────────
{
	let rejectLate: ((error: unknown) => void) | undefined;
	const originalError = console.error;
	console.error = () => {};
	try {
		const out = await recallLongTermMemoryBlock({
			userText: "What are Acme's payment terms?",
			search: () =>
				new Promise<MemorySearchResult>((_resolve, reject) => {
					rejectLate = reject;
				}),
			budgetMs: 10,
		});
		assert.equal(out.outcome, "timed_out");
		rejectLate?.(new Error("late"));
		await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		console.error = originalError;
	}
}

console.log("memory-recall: all assertions passed");
