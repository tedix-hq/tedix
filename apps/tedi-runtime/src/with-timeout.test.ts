/**
 * Tests for `withTimeout` — the cold-start-stall guard that converts a hung
 * await into a `TimeoutError` so a wedged turn fails toward retry/fail-soft
 * instead of sitting at `run.started` forever.
 *
 * Deterministic: uses tiny real timers + a never-resolving promise. No DO, no
 * live tedi.
 *
 * Run: `bun run src/with-timeout.test.ts`.
 */

import assert from "node:assert/strict";
import { TimeoutError, withTimeout } from "./with-timeout";

// ── a promise that settles before the timeout resolves with its value ────────
{
	const fast = new Promise<string>((resolve) =>
		setTimeout(() => resolve("ok"), 5),
	);
	const res = await withTimeout(fast, 100, "fast");
	assert.equal(res, "ok", "a promise that settles first returns its value");
	console.log("PASS: settles-first returns the value");
}

// ── a hung (never-resolving) promise rejects with TimeoutError after the bound ─
{
	let threw: unknown;
	const start = Date.now();
	const hung = new Promise<string>(() => {}); // never settles — the stall
	try {
		await withTimeout(hung, 20, "ensureSynced (cold-start guard)");
	} catch (err) {
		threw = err;
	}
	const elapsed = Date.now() - start;
	assert.ok(threw instanceof TimeoutError, "a hung await throws TimeoutError");
	assert.equal(
		(threw as TimeoutError).timeoutMs,
		20,
		"carries the timeout bound",
	);
	assert.ok(
		String(threw).includes("ensureSynced (cold-start guard)"),
		"the label is in the message so logs identify the stall site",
	);
	assert.ok(
		elapsed >= 18 && elapsed < 500,
		`rejects ~at the bound (elapsed=${elapsed}ms)`,
	);
	console.log("PASS: hung await rejects with TimeoutError at the bound");
}

// ── a rejecting promise propagates its OWN error (not a TimeoutError) ─────────
{
	let threw: unknown;
	const fails = new Promise<string>((_, reject) =>
		setTimeout(() => reject(new Error("upstream 503")), 5),
	);
	try {
		await withTimeout(fails, 100, "sync");
	} catch (err) {
		threw = err;
	}
	assert.ok(threw instanceof Error, "rejection propagates");
	assert.ok(
		!(threw instanceof TimeoutError),
		"an early rejection is NOT a timeout",
	);
	assert.ok(
		String(threw).includes("upstream 503"),
		"the original error is preserved",
	);
	console.log("PASS: early rejection propagates the original error");
}

// ── a late rejection (after the timeout already fired) does not crash ─────────
// Guards the unhandled-rejection swallow. If the no-op `.catch` were missing,
// this rejection would surface ~30ms after we've already handled the timeout.
{
	let timedOut = false;
	const lateReject = new Promise<string>((_, reject) =>
		setTimeout(() => reject(new Error("late upstream failure")), 30),
	);
	try {
		await withTimeout(lateReject, 10, "late");
	} catch (err) {
		timedOut = err instanceof TimeoutError;
	}
	assert.ok(timedOut, "timed out first");
	// Give the late rejection time to fire; if it were unhandled the runner would
	// flag it. Reaching the next line cleanly is the assertion.
	await new Promise((r) => setTimeout(r, 40));
	console.log(
		"PASS: a late rejection after timeout does not surface as unhandled",
	);
}

console.log("\nAll with-timeout tests passed.");
