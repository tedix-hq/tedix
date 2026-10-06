/**
 * Unit tests for the self-healing STT session wrapper (`self-healing.ts`).
 *
 * Same style as the other standalone test files in this directory (node:assert,
 * run as a plain bun script — no vitest or cloudflare:workers needed):
 *   bun run src/self-healing.test.ts
 *
 * Tests:
 *   1. Events proxy through: onInterim / onSpeechStart / onUtterance are all
 *      forwarded to the consumer-supplied callbacks.
 *   2. Watchdog does NOT fire while STT events keep arriving within stallMs.
 *   3. Stall → new session created + rolling buffer replayed in order + heal
 *      logged, using a very small stallMs (50 ms) and real timers.
 *   4. Heal cap: after maxHeals exhausted, stt.heal.exhausted is logged and no
 *      further heals happen.
 *   5. Duplicate-utterance suppression after a heal.
 *   6. Rolling buffer byte-cap eviction: oldest chunks are evicted.
 *   7. Readiness is preserved through both Tedix transcriber wrappers.
 *   8. close() clears timers and closes the inner session; no events after close.
 */

import assert from "node:assert/strict";
import type {
	Transcriber,
	TranscriberSession,
	TranscriberSessionOptions,
} from "@cloudflare/voice";
import { createInstrumentedVoiceTranscriber } from "./runtime";
import { createSelfHealingTranscriber } from "./self-healing";

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

interface FakeSessionRecord {
	options: TranscriberSessionOptions | undefined;
	fed: ArrayBuffer[];
	closed: boolean;
	// test handle for firing events
	fire: {
		interim(text: string): void;
		speechStart(text?: string): void;
		utterance(text: string): void;
	};
}

function makeFakeTranscriber(): {
	transcriber: Transcriber;
	sessions: FakeSessionRecord[];
} {
	const sessions: FakeSessionRecord[] = [];

	const transcriber: Transcriber = {
		createSession(options?: TranscriberSessionOptions): TranscriberSession {
			const rec: FakeSessionRecord = {
				options,
				fed: [],
				closed: false,
				fire: {
					interim: (t) => options?.onInterim?.(t),
					speechStart: (t) => options?.onSpeechStart?.(t),
					utterance: (t) => options?.onUtterance?.(t),
				},
			};
			sessions.push(rec);
			return {
				feed(chunk: ArrayBuffer): void {
					if (!rec.closed) rec.fed.push(chunk);
				},
				close(): void {
					rec.closed = true;
				},
			};
		},
	};

	return { transcriber, sessions };
}

/** Create a tiny ArrayBuffer filled with a marker byte for identity checks. */
function chunk(marker: number, size = 8): ArrayBuffer {
	const buf = new ArrayBuffer(size);
	new Uint8Array(buf).fill(marker);
	return buf;
}

/** Sleep for `ms` milliseconds (real timer). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReadyTranscriber(ready: Promise<void>): Transcriber {
	return {
		createSession(): TranscriberSession {
			return {
				feed() {},
				waitUntilReady: () => ready,
				close() {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(
	name: string,
	fn: () => void | Promise<void>,
): Promise<void> {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (err) {
		console.error(`  ✗ ${name}`);
		console.error("   ", err instanceof Error ? err.message : String(err));
		failed++;
	}
}

// ---------------------------------------------------------------------------
// 1. Events proxy through
// ---------------------------------------------------------------------------

await test("onInterim / onSpeechStart / onUtterance are forwarded to consumer", () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const healer = createSelfHealingTranscriber(transcriber, { stallMs: 10_000 });

	const interims: string[] = [];
	const speechStarts: Array<string | undefined> = [];
	const utterances: string[] = [];

	const session = healer.createSession({
		onInterim: (t) => interims.push(t),
		onSpeechStart: (t) => speechStarts.push(t),
		onUtterance: (t) => utterances.push(t),
	});

	const s0 = sessions[0]!;
	s0.fire.interim("hello");
	s0.fire.speechStart("hi?");
	s0.fire.speechStart(undefined);
	s0.fire.utterance("Hello there.");

	assert.deepEqual(interims, ["hello"]);
	assert.deepEqual(speechStarts, ["hi?", undefined]);
	assert.deepEqual(utterances, ["Hello there."]);

	session.close();
});

// ---------------------------------------------------------------------------
// 2. Watchdog does NOT fire while events keep arriving
// ---------------------------------------------------------------------------

await test("watchdog does not fire while events arrive within stallMs", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logs: string[] = [];

	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 80, // short — events must keep arriving to suppress it
		log: (event) => logs.push(event),
	});

	const session = healer.createSession({});

	// Feed audio and fire an event every 40 ms for 200 ms.
	for (let i = 0; i < 5; i++) {
		session.feed(chunk(i));
		sessions[sessions.length - 1]!.fire.interim(`partial ${i}`);
		await sleep(40);
	}

	assert.equal(
		logs.filter((e) => e.startsWith("stt.heal")).length,
		0,
		"no heal should have fired",
	);
	assert.equal(sessions.length, 1, "only one inner session should exist");

	session.close();
});

// ---------------------------------------------------------------------------
// 3. Stall → new session + buffer replayed in order + heal logged
// ---------------------------------------------------------------------------

await test("stall triggers heal: new session created, buffer replayed in order, stt.heal logged", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logEvents: Array<{ event: string; fields: Record<string, unknown> }> =
		[];

	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 50, // low so we can trigger in-test with real timers
		maxBufferBytes: 1_000_000, // big — no eviction in this test
		maxHeals: 1, // cap at one heal so the assertion is deterministic
		_watchTickMs: 20, // fast tick so stall fires within 200ms sleep
		log: (event, fields) => logEvents.push({ event, fields }),
	});

	const utterances: string[] = [];
	const session = healer.createSession({
		onUtterance: (t) => utterances.push(t),
	});

	// Feed three chunks.
	const c1 = chunk(1, 100);
	const c2 = chunk(2, 100);
	const c3 = chunk(3, 100);
	session.feed(c1);
	session.feed(c2);
	session.feed(c3);

	// No events fired → wait past stallMs.
	await sleep(200);

	// One heal should have occurred.
	const healLogs = logEvents.filter((e) => e.event === "stt.heal");
	assert.equal(healLogs.length, 1, "exactly one heal logged");
	assert.equal(healLogs[0]!.fields.generation, 1);
	assert.equal(healLogs[0]!.fields.replayedChunks, 3);
	assert.equal(healLogs[0]!.fields.replayedBytes, 300);

	// Two inner sessions should have been created.
	assert.equal(sessions.length, 2, "second session opened on heal");

	// The second session should have received all three chunks in order.
	const s1 = sessions[1]!;
	assert.equal(s1.fed.length, 3, "three chunks replayed to new session");
	assert.equal(new Uint8Array(s1.fed[0]!)[0], 1, "first replayed chunk is c1");
	assert.equal(new Uint8Array(s1.fed[1]!)[0], 2, "second replayed chunk is c2");
	assert.equal(new Uint8Array(s1.fed[2]!)[0], 3, "third replayed chunk is c3");

	// First session should be closed.
	assert.ok(sessions[0]!.closed, "stale session closed on heal");

	session.close();
});

// ---------------------------------------------------------------------------
// 4. Heal cap: stt.heal.exhausted after maxHeals
// ---------------------------------------------------------------------------

await test("heal cap: stt.heal.exhausted logged after maxHeals, no further heals", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logEvents: Array<{ event: string; fields: Record<string, unknown> }> =
		[];

	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 50,
		maxHeals: 2,
		_watchTickMs: 20,
		log: (event, fields) => logEvents.push({ event, fields }),
	});

	const session = healer.createSession({});

	// Feed audio and never fire any events — let all heals exhaust.
	session.feed(chunk(1));
	await sleep(400); // well past stallMs * maxHeals

	const healCount = logEvents.filter((e) => e.event === "stt.heal").length;
	const exhaustedCount = logEvents.filter(
		(e) => e.event === "stt.heal.exhausted",
	).length;

	assert.equal(healCount, 2, "exactly maxHeals heals happened");
	assert.equal(exhaustedCount, 1, "exhausted logged once");
	// sessions: original + 2 heals = 3
	assert.equal(sessions.length, 3, "3 total inner sessions");

	session.close();
});

// ---------------------------------------------------------------------------
// 5. Duplicate-utterance suppression after a heal
// ---------------------------------------------------------------------------

await test("duplicate utterance suppression after heal", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logEvents: Array<{ event: string; fields: Record<string, unknown> }> =
		[];

	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 50,
		maxHeals: 1, // cap at one heal so exactly 2 sessions are created
		dupWindowMs: 15_000,
		_watchTickMs: 20,
		log: (event, fields) => logEvents.push({ event, fields }),
	});

	const utterances: string[] = [];
	const session = healer.createSession({
		onUtterance: (t) => utterances.push(t),
	});

	// Emit an utterance from the first session.
	sessions[0]!.fire.utterance("Hello there.");
	assert.deepEqual(utterances, ["Hello there."]);

	// Feed audio without events → trigger heal.
	session.feed(chunk(1));
	await sleep(200);
	assert.equal(sessions.length, 2, "healed to second session");

	// The new session re-emits the same utterance (replay artifact).
	sessions[1]!.fire.utterance("Hello there.");

	// Should be suppressed.
	assert.deepEqual(utterances, ["Hello there."], "duplicate suppressed");

	const dupLogs = logEvents.filter(
		(e) => e.event === "stt.heal.dup_suppressed",
	);
	assert.equal(dupLogs.length, 1, "stt.heal.dup_suppressed logged once");
	assert.deepEqual(dupLogs[0]?.fields, {
		generation: 1,
		chars: "Hello there.".length,
	});
	assert.doesNotMatch(JSON.stringify(dupLogs), /Hello there/);

	// A DIFFERENT utterance must NOT be suppressed.
	sessions[1]!.fire.utterance("Different text.");
	assert.deepEqual(utterances, ["Hello there.", "Different text."]);

	session.close();
});

// ---------------------------------------------------------------------------
// 6. Rolling buffer byte-cap eviction
// ---------------------------------------------------------------------------

await test("rolling buffer evicts oldest chunks when maxBufferBytes exceeded", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logEvents: Array<{ event: string; fields: Record<string, unknown> }> =
		[];

	// Max buffer = 250 bytes; each chunk is 100 bytes — so max 2 chunks fit.
	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 50,
		maxBufferBytes: 250,
		maxHeals: 1,
		_watchTickMs: 20,
		log: (event, fields) => logEvents.push({ event, fields }),
	});

	const session = healer.createSession({});

	// Feed 4 chunks × 100 bytes = 400 bytes; only the last 2 (200 bytes) fit.
	session.feed(chunk(1, 100));
	session.feed(chunk(2, 100));
	session.feed(chunk(3, 100));
	session.feed(chunk(4, 100));

	// Trigger a heal.
	await sleep(200);

	const healLog = logEvents.find((e) => e.event === "stt.heal");
	assert.ok(healLog, "heal occurred");
	assert.equal(
		healLog!.fields.replayedChunks,
		2,
		"only 2 chunks fit in buffer",
	);
	assert.equal(healLog!.fields.replayedBytes, 200, "200 bytes replayed");

	// Replayed chunks should be c3 and c4 (markers 3, 4).
	const s1 = sessions[1]!;
	assert.equal(s1.fed.length, 2);
	assert.equal(
		new Uint8Array(s1.fed[0]!)[0],
		3,
		"oldest surviving chunk is c3",
	);
	assert.equal(new Uint8Array(s1.fed[1]!)[0], 4, "newest chunk is c4");

	session.close();
});

// ---------------------------------------------------------------------------
// 7. Readiness survives both wrappers
// ---------------------------------------------------------------------------

await test("self-healing wrapper preserves deferred readiness", async () => {
	let resolveReady: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const session = createSelfHealingTranscriber(
		makeReadyTranscriber(ready),
	).createSession();
	assert.ok(session.waitUntilReady, "self-healing session exposes readiness");
	let settled = false;
	const waiting = session.waitUntilReady().then(() => {
		settled = true;
	});

	await Promise.resolve();
	assert.equal(settled, false, "readiness must remain pending");
	resolveReady?.();
	await waiting;
	assert.equal(settled, true, "readiness resolves with the base session");
	session.close();
});

await test("instrumented wrapper preserves readiness rejection", async () => {
	const expected = new Error("transcriber startup failed");
	const transcriber = createInstrumentedVoiceTranscriber({
		base: makeReadyTranscriber(Promise.reject(expected)),
		fields: () => ({ surface: "test" }),
		log: () => {},
	});
	assert.ok(transcriber);
	const session = transcriber.createSession();
	assert.ok(session.waitUntilReady, "instrumented session exposes readiness");
	await assert.rejects(session.waitUntilReady(), expected);
	session.close();
});

// ---------------------------------------------------------------------------
// 8. close() clears timers and closes inner session; no events after close
// ---------------------------------------------------------------------------

await test("close() clears watchdog timer and closes inner session", async () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const logEvents: string[] = [];

	const healer = createSelfHealingTranscriber(transcriber, {
		stallMs: 50,
		_watchTickMs: 20,
		log: (event) => logEvents.push(event),
	});

	const session = healer.createSession({});
	session.feed(chunk(1));

	// Close BEFORE stall fires.
	session.close();
	assert.ok(sessions[0]!.closed, "inner session closed immediately on close()");

	// Wait past stallMs — watchdog must NOT fire after close.
	await sleep(200);
	assert.equal(
		logEvents.filter((e) => e.startsWith("stt.heal")).length,
		0,
		"no heal after close",
	);
});

await test("events from inner session after close() are silently dropped", () => {
	const { transcriber, sessions } = makeFakeTranscriber();
	const utterances: string[] = [];

	const healer = createSelfHealingTranscriber(transcriber, { stallMs: 10_000 });
	const session = healer.createSession({
		onUtterance: (t) => utterances.push(t),
	});

	session.close();
	// Fire an event after close — should not reach consumer.
	sessions[0]!.fire.utterance("ghost utterance");
	assert.deepEqual(utterances, [], "event after close discarded");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed > 0) {
	console.error(`\nself-healing.test.ts: ${passed} passed, ${failed} FAILED`);
	process.exit(1);
} else {
	console.log(`\nself-healing.test.ts: all ${passed} assertions passed`);
}
