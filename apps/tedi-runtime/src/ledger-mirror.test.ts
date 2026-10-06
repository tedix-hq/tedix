/**
 * Migration-aware regression for the runId surface tag (body-name → body-neutral
 * surface) and the stable-turnKey identity scheme. The canonical event-id scheme
 * is `{runId}:{seq}` where `runId = {tediId}:{surface}:{turnKey}` and `turnKey`
 * is the inbound client-generated message id (NEVER a wall-clock). The surface
 * tag MUST round-trip byte-for-byte through parse→rebuild (INCLUDING legacy
 * `isolate`-tagged chains), and the SAME inbound id must always yield the SAME
 * runId across re-processing, or the deterministic dedup (conflict-do-nothing on
 * `runtimeEventId`) breaks and duplicates events.
 * Run: `bun run src/ledger-mirror.test.ts`.
 */
import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HttpPlatformClient } from "./brain/platform-client";
import {
	buildRunId,
	isEphemeralSession,
	mirrorFailedTurnToLedger,
	mirrorTurnToLedger,
	parseRunSurface,
	sanitizeTurnKey,
} from "./ledger-mirror";

const TEDI = "5eed0042-0000-4000-8000-000000000042"; // colonless UUID

// ── New surfaces build the expected runId (string turnKey) ────────────────────
assert.equal(buildRunId(TEDI, "abc", "chat"), `${TEDI}:chat:abc`);
assert.equal(buildRunId(TEDI, "abc", "mcp"), `${TEDI}:mcp:abc`);
assert.equal(
	buildRunId(TEDI, "abc"),
	`${TEDI}:chat:abc`,
	"default surface is chat",
);

// ── sanitizeTurnKey: colon stripping, <> stripping, whitespace, empty→throw ───
assert.equal(sanitizeTurnKey("plain-id"), "plain-id");
assert.equal(
	sanitizeTurnKey("a:b:c"),
	"a_b_c",
	"colons → underscores (would shift parseRunSurface segment)",
);
assert.equal(
	sanitizeTurnKey("<msg-123@mail.example>"),
	"msg-123@mail.example",
	"surrounding angle brackets stripped (email Message-ID)",
);
assert.equal(
	sanitizeTurnKey("  spaced  out  id  "),
	"spaced_out_id",
	"internal whitespace collapsed + trimmed",
);
assert.equal(
	sanitizeTurnKey("<<weird:id>>"),
	"weird_id",
	"nested brackets + colon both handled",
);
assert.throws(
	() => sanitizeTurnKey("   "),
	/empty turnKey/,
	"whitespace-only id throws (no fabricated key)",
);
assert.throws(
	() => sanitizeTurnKey("<>"),
	/empty turnKey/,
	"bracket-only id throws",
);

// ── buildRunId applies sanitizeTurnKey to its turnKey ─────────────────────────
assert.equal(
	buildRunId(TEDI, "<msg-9@x>", "chat"),
	`${TEDI}:chat:msg-9@x`,
	"buildRunId sanitizes the turnKey (brackets stripped)",
);
assert.equal(
	parseRunSurface(buildRunId(TEDI, "a:b:c", "mcp")),
	"mcp",
	"a colon-laden raw id never corrupts the surface segment",
);

// ── parseRunSurface reads the literal middle segment ─────────────────────────
assert.equal(parseRunSurface(`${TEDI}:chat:abc`), "chat");
assert.equal(parseRunSurface(`${TEDI}:mcp:abc`), "mcp");
assert.equal(
	parseRunSurface(`${TEDI}:isolate:abc`),
	"isolate",
	"LEGACY body-name tag is preserved verbatim, never remapped",
);

// ── THE migration invariant: rebuild∘parse is identity for every surface ─────
// This is what keeps `{runId}:{seq}` dedup stable: the post-turn mirror parses
// the live turn's runId and rebuilds it; the rebuilt runId must equal the
// original so both emit the same event ids.
for (const surface of ["chat", "mcp", "isolate"]) {
	const runId = `${TEDI}:${surface}:turnkey777`;
	assert.equal(
		buildRunId(TEDI, "turnkey777", parseRunSurface(runId)),
		runId,
		`buildRunId∘parseRunSurface is identity for surface=${surface}`,
	);
}

// ── A legacy turn that completes AFTER the rename keeps its isolate event ids ─
{
	const legacyRunId = `${TEDI}:isolate:turn555`;
	const mirrorRebuilt = buildRunId(
		TEDI,
		"turn555",
		parseRunSurface(legacyRunId),
	);
	assert.equal(
		mirrorRebuilt,
		legacyRunId,
		"deploy-boundary legacy turn: ids unchanged",
	);
	assert.equal(`${mirrorRebuilt}:0`, `${legacyRunId}:0`);
	assert.equal(`${mirrorRebuilt}:2`, `${legacyRunId}:2`);
}

// ── Stable-id identity: same inbound client id ⇒ same runId every time ────────
// Models turn preparation and response mirroring deriving the runId from the SAME persisted
// user-message id, and a redelivered MCP turn carrying the same clientRequestId.
{
	const userMessageId = "uimsg-018f-aaaa"; // client-generated UIMessage id
	const preparedRunId = buildRunId(TEDI, userMessageId, "chat");
	const onChatResponseRunId = buildRunId(TEDI, userMessageId, "chat");
	assert.equal(
		preparedRunId,
		onChatResponseRunId,
		"preparation and response mirroring derive the SAME runId from the same user id",
	);

	// Redelivered MCP turn: same clientRequestId ⇒ same runId ⇒ same idempotency
	// keys, so the dedup'd append/event write collapses to one row.
	const clientRequestId = "mesh-req-42";
	const firstDelivery = buildRunId(TEDI, clientRequestId, "mcp");
	const redelivery = buildRunId(TEDI, clientRequestId, "mcp");
	assert.equal(
		firstDelivery,
		redelivery,
		"redelivered MCP turn with same clientRequestId yields same runId",
	);
	// idempotency keys derive purely from runId (see session-repo deriveIdempotencyKey)
	assert.equal(`${firstDelivery}:0`, `${redelivery}:0`, "user key dedups");
	assert.equal(`${firstDelivery}:2`, `${redelivery}:2`, "assistant key dedups");
}

// ── isEphemeralSession — __throwaway:/__test: prefixes opt out of ledger ──────
assert.equal(isEphemeralSession("__throwaway:codex-smoke"), true);
assert.equal(isEphemeralSession("__test:val-123"), true);
assert.equal(isEphemeralSession("agent:main:main"), false);
assert.equal(isEphemeralSession("os:user-42"), false);
assert.equal(isEphemeralSession(""), false, "empty key is not ephemeral");
assert.equal(
	isEphemeralSession(undefined),
	false,
	"undefined is not ephemeral",
);
assert.equal(
	isEphemeralSession("not__throwaway:x"),
	false,
	"prefix must be at the START of the session key",
);

// ── Terminal (run.completed) write retries on transient failure ──────────────
// A fake platform whose recordRuntimeEvent fails the FIRST two run.completed
// attempts then succeeds. seq0..seq2 are single-attempt best-effort; seq3
// (terminal) must be retried so a transient blip does not strand the run.
{
	const attemptsByKind: Record<string, number> = {};
	let terminalFailuresInjected = 0;
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			attemptsByKind[event.kind] = (attemptsByKind[event.kind] ?? 0) + 1;
			if (event.kind === "run.completed" && terminalFailuresInjected < 2) {
				terminalFailuresInjected++;
				throw new Error("transient 503");
			}
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:main`,
		runId: buildRunId(TEDI, "turn-retry-1", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
	});

	assert.equal(
		attemptsByKind["message.received"],
		1,
		"non-terminal seq0 is single-attempt",
	);
	assert.equal(
		attemptsByKind["message.completed"],
		1,
		"non-terminal seq2 is single-attempt",
	);
	assert.equal(
		attemptsByKind["run.completed"],
		3,
		"terminal seq3 retried twice then succeeded (3 total attempts)",
	);
}

// ── Durable Code Mode pause parks the run instead of completing it ──────────
{
	const kinds: string[] = [];
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			kinds.push(event.kind);
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:main`,
		runId: buildRunId(TEDI, "turn-durable-pause", "mcp"),
		userTurn: { content: "write proof", ts: Date.now() },
		assistantTurn: { content: "Waiting for approval", ts: Date.now() },
		durableCodePause: {
			executionId: "exec-1",
			pending: [
				{
					args: { path: "/proof.txt" },
					connector: "workspace",
					executionId: "exec-1",
					method: "write_file",
					seq: 0,
				},
			],
		},
	});

	assert.equal(kinds.includes("approval.requested"), true);
	assert.equal(kinds.includes("run.completed"), false);
}

// ── A non-terminal write failing does NOT retry (stays best-effort) ──────────
{
	const attemptsByKind: Record<string, number> = {};
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			attemptsByKind[event.kind] = (attemptsByKind[event.kind] ?? 0) + 1;
			if (event.kind === "message.received") {
				throw new Error("transient 503");
			}
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:main`,
		runId: buildRunId(TEDI, "turn-retry-2", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
	});

	assert.equal(
		attemptsByKind["message.received"],
		1,
		"non-terminal failure is NOT retried (best-effort, single attempt)",
	);
	assert.equal(
		attemptsByKind["run.completed"],
		1,
		"terminal still written once",
	);
}

// ── Cross-layer trace metadata stays attached to mirrored runtime events ─────
{
	const events: TediRuntimeEvent[] = [];
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;
	const traceId = "a847d3db-6130-4136-b3cc-7bc6eb6de030";

	await mirrorTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:trace`,
		runId: buildRunId(TEDI, "turn-trace-1", "mcp"),
		traceId,
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
	});

	assert.ok(events.length >= 4, "trace test recorded the success chain");
	for (const event of events) {
		assert.equal(
			event.runtime?.metadata?.traceId,
			traceId,
			`${event.kind} carries runtime.metadata.traceId`,
		);
	}
}

// ── Voice-message attachments stay visible in the canonical ledger ───────────
{
	const events: TediRuntimeEvent[] = [];
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:voice-note`,
		runId: buildRunId(TEDI, "voice-attachment-1", "mcp"),
		userTurn: {
			content: "[Voice message transcript]\nhello from audio",
			attachments: [
				{
					content: "data:audio/wav;base64,UklGRg==",
					fileName: "voice.wav",
					mimeType: "audio/wav",
					type: "audio",
				},
			],
			ts: Date.now(),
		},
		assistantTurn: { content: "received", ts: Date.now() },
	});

	const received = events.find((event) => event.kind === "message.received");
	assert.deepEqual(
		(received?.payload as { attachments?: unknown[] } | undefined)?.attachments,
		[
			{
				content: "data:audio/wav;base64,UklGRg==",
				fileName: "voice.wav",
				mimeType: "audio/wav",
				type: "audio",
			},
		],
		"message.received preserves the audio attachment for Tedix OS rendering",
	);
}

// ── Body-parity: run.completed carries tokensUsed when trace usage is present ─
// Isolate runs MUST report tokensUsed on run.completed the same way the kernel
// does — observers distinguish "no data" (absent) from "zero tokens" (not legal
// for a real turn). Validates both the present-and-positive and absent-omitted
// invariants of the null-absent contract.
{
	// Case 1: tokensUsed present → run.completed payload carries it
	const events1: TediRuntimeEvent[] = [];
	const fakePlatform1 = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events1.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform1,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:tokens-present`,
		runId: buildRunId(TEDI, "turn-tokens-present", "chat"),
		userTurn: { content: "query", ts: Date.now() },
		assistantTurn: { content: "answer", ts: Date.now() },
		tokensUsed: 2450,
	});

	const completed1 = events1.find((e) => e.kind === "run.completed");
	assert.ok(completed1, "run.completed event emitted");
	assert.equal(
		(completed1?.payload as { tokensUsed?: unknown } | undefined)?.tokensUsed,
		2450,
		"run.completed.payload.tokensUsed carries the summed token count",
	);

	// Case 2: tokensUsed absent → run.completed payload is omitted (null-absent)
	const events2: TediRuntimeEvent[] = [];
	const fakePlatform2 = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events2.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform2,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:tokens-absent`,
		runId: buildRunId(TEDI, "turn-tokens-absent", "chat"),
		userTurn: { content: "query", ts: Date.now() },
		assistantTurn: { content: "answer", ts: Date.now() },
		// tokensUsed deliberately omitted
	});

	const completed2 = events2.find((e) => e.kind === "run.completed");
	assert.ok(completed2, "run.completed event emitted (no-usage turn)");
	assert.ok(
		completed2?.payload == null ||
			!Object.hasOwn(completed2.payload, "tokensUsed"),
		"run.completed has NO tokensUsed key when trace usage is absent (null-absent invariant)",
	);

	// Case 3: tokensUsed = null explicitly → omitted (same as absent)
	const events3: TediRuntimeEvent[] = [];
	const fakePlatform3 = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events3.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: fakePlatform3,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:tokens-null`,
		runId: buildRunId(TEDI, "turn-tokens-null", "chat"),
		userTurn: { content: "query", ts: Date.now() },
		assistantTurn: { content: "answer", ts: Date.now() },
		tokensUsed: null,
	});

	const completed3 = events3.find((e) => e.kind === "run.completed");
	assert.ok(completed3, "run.completed event emitted (null usage turn)");
	assert.ok(
		completed3?.payload == null ||
			!Object.hasOwn(completed3.payload, "tokensUsed"),
		"run.completed has NO tokensUsed key when tokensUsed is explicitly null",
	);

	const partialEvents: TediRuntimeEvent[] = [];
	const partialPlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			partialEvents.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;
	await mirrorTurnToLedger({
		platform: partialPlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:partial`,
		runId: buildRunId(TEDI, "turn-partial", "mcp"),
		userTurn: { content: "query", ts: Date.now() },
		assistantTurn: { content: "partial answer", ts: Date.now() },
		stopReason: "step_ceiling",
	});
	const partialCompleted = partialEvents.find(
		(event) => event.kind === "run.completed",
	);
	assert.equal(
		(partialCompleted?.payload as { stopReason?: unknown } | undefined)
			?.stopReason,
		"step_ceiling",
		"run.completed preserves structured partial stop reasons",
	);
}

// ── Setup-error path: mirrorFailedTurnToLedger emits run.failed with no assistant
// Models a setup-level throw (missing Azure key, identity failure) BEFORE a model
// call is made — no assistant text, just the user message + error reason.
{
	const events: TediRuntimeEvent[] = [];
	const fakePlatform = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			events.push(event);
			return {};
		},
	} as unknown as HttpPlatformClient;

	const setupRunId = buildRunId(TEDI, "inject-setup-fail-1", "mcp");
	await mirrorFailedTurnToLedger({
		platform: fakePlatform,
		tediId: TEDI,
		conversationId: `${TEDI}:mcp:setup-fail-session`,
		runId: setupRunId,
		userTurn: { content: "delegate this task", ts: Date.now() },
		// no assistantTurn — setup failed before model ran
		error: "setup_error: AI Gateway BYOK not configured",
	});

	const failed = events.find((e) => e.kind === "run.failed");
	assert.ok(
		failed,
		"setup-error path emits run.failed terminal event (no silent drop)",
	);
	assert.equal(
		(failed?.payload as { error?: string } | undefined)?.error?.includes(
			"AI Gateway BYOK",
		),
		true,
		"run.failed payload carries the setup error message",
	);

	const started = events.find((e) => e.kind === "run.started");
	assert.ok(started, "run.started emitted before run.failed");

	const received = events.find((e) => e.kind === "message.received");
	assert.ok(received, "message.received emitted with the user turn");

	const messageCompleted = events.find((e) => e.kind === "message.completed");
	assert.ok(
		!messageCompleted,
		"no message.completed when setup fails before model runs",
	);
}

// ── Setup-error idempotency: same clientRequestId ⇒ same runId ⇒ same event ids
// A 3-retry schedule delivering setup_error must dedup to the same run, not fan
// out 3 orphan runs.
{
	const firstDelivery = buildRunId(TEDI, "inject-idem-42", "mcp");
	const retry = buildRunId(TEDI, "inject-idem-42", "mcp");
	assert.equal(
		firstDelivery,
		retry,
		"setup-error retries dedup to the same runId (conflict-do-nothing on ledger)",
	);
}

// ── Terminal drop → onTerminalDrop hook (durable outbox seam) ─────────────────
// A run.completed that exhausts all in-process attempts must hand the EXACT
// terminal event to the durable sink; non-terminal drops must not.
{
	const dropped: TediRuntimeEvent[] = [];
	const alwaysFails = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			if (event.kind === "run.completed") throw new Error("transient 503");
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: alwaysFails,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:drop-1`,
		runId: buildRunId(TEDI, "turn-drop-1", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
		onTerminalDrop: (event) => {
			dropped.push(event);
		},
	});

	assert.equal(dropped.length, 1, "terminal drop invoked the outbox hook once");
	assert.equal(
		dropped[0]?.kind,
		"run.completed",
		"hook received the terminal event",
	);
	assert.equal(
		dropped[0]?.runId,
		buildRunId(TEDI, "turn-drop-1", "chat"),
		"hook event carries the run identity needed for idempotent redrive",
	);
}

{
	// Non-terminal failure (message.received) must NOT reach the terminal sink.
	const dropped: TediRuntimeEvent[] = [];
	const failsNonTerminal = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			if (event.kind === "message.received") throw new Error("boom");
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: failsNonTerminal,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:drop-2`,
		runId: buildRunId(TEDI, "turn-drop-2", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
		onTerminalDrop: (event) => {
			dropped.push(event);
		},
	});
	assert.equal(dropped.length, 0, "non-terminal drops stay best-effort");
}

{
	// run.failed terminal drop goes through the same sink on the failed-turn path.
	const dropped: TediRuntimeEvent[] = [];
	const failsTerminal = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			if (event.kind === "run.failed") throw new Error("transient 503");
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorFailedTurnToLedger({
		platform: failsTerminal,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:drop-3`,
		runId: buildRunId(TEDI, "turn-drop-3", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		error: "model exploded",
		onTerminalDrop: (event) => {
			dropped.push(event);
		},
	});
	assert.equal(dropped.length, 1, "run.failed drop reached the outbox hook");
	assert.equal(dropped[0]?.kind, "run.failed", "hook received run.failed");
}

{
	// A hook that itself throws must not break the mirror (fail-soft contract).
	const alwaysFails = {
		async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
			if (event.kind === "run.completed") throw new Error("transient 503");
			return {};
		},
	} as unknown as HttpPlatformClient;

	await mirrorTurnToLedger({
		platform: alwaysFails,
		tediId: TEDI,
		conversationId: `${TEDI}:agent:main:drop-4`,
		runId: buildRunId(TEDI, "turn-drop-4", "chat"),
		userTurn: { content: "hi", ts: Date.now() },
		assistantTurn: { content: "hello", ts: Date.now() },
		onTerminalDrop: () => {
			throw new Error("storage write failed");
		},
	});
	// Reaching this line without throwing IS the assertion.
}

// Exercise the native mirror payload, before transport serialization can erase
// an accidentally present `reason: undefined` property.
{
	const envelope =
		"workflow errored before terminal: Computer execution status read failed: workstation job observation unavailable";
	const diagnosticsError = `${envelope}; diagnostics=${JSON.stringify({
		detail:
			"Durable Object reset because its code was updated; out of memory; empty_assistant_message",
		padding: "x".repeat(2200),
	})}`;
	const cases = [
		{ error: envelope, reason: undefined },
		{ error: diagnosticsError, reason: undefined },
		{ error: `"${envelope}"`, reason: "llm_error" },
		{
			error: `provider quoted: ${envelope}; diagnostics={}`,
			reason: "llm_error",
		},
		{ error: `${envelope}_lookalike`, reason: "llm_error" },
		{ error: `${envelope}X; diagnostics={}`, reason: "llm_error" },
		{ error: `${envelope}-ish`, reason: "llm_error" },
		{ error: `${envelope}; diagnostics_lookalike={}`, reason: "llm_error" },
		{ error: "provider request failed: 503", reason: "llm_error" },
		{
			error: "Durable Object reset because its code was updated",
			reason: "runtime_dropped",
		},
		{ error: "isolate exceeded its memory limit", reason: "runtime_dropped" },
	];
	for (const content of [
		undefined,
		"   ",
		"Inspection interrupted before results.",
	]) {
		for (const recovery of [
			undefined,
			{
				rootRequestId: "recovery-root",
				incidentId: "recovery-incident",
				reason: "attempts_exhausted",
				attempts: 3,
				partialTextLength: 0,
			},
		]) {
			for (const testCase of [
				...cases,
				{
					error: "empty_assistant_message",
					reason: content?.trim() ? "llm_error" : "empty_message",
				},
			]) {
				const events: TediRuntimeEvent[] = [];
				const platform = {
					async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
						events.push(event);
						return {};
					},
				} as unknown as HttpPlatformClient;
				const runId = buildRunId(TEDI, "observer-turn", "mcp");
				const conversationId = `${TEDI}:mcp:observer-session`;
				await mirrorFailedTurnToLedger({
					platform,
					tediId: TEDI,
					conversationId,
					runId,
					traceId: "observer-trace",
					userTurn: { content: "inspect repository", ts: 1700000000000 },
					...(content === undefined
						? {}
						: { assistantTurn: { content, ts: 1700000001000 } }),
					error: testCase.error,
					recovery,
				});
				const withProse = Boolean(content?.trim());
				assert.deepEqual(
					events.map((event) => event.kind),
					withProse
						? [
								"message.received",
								"run.started",
								"message.completed",
								"run.failed",
							]
						: ["message.received", "run.started", "run.failed"],
				);
				for (const [sequence, event] of events.entries()) {
					assert.equal(event.id, `${runId}:${sequence}`);
					assert.equal(event.sequence, sequence);
					assert.equal(event.tediId, TEDI);
					assert.equal(event.runId, runId);
					assert.equal(event.conversationId, conversationId);
					assert.equal(event.runtime?.metadata?.traceId, "observer-trace");
				}
				const failed = events.at(-1)!;
				const expectedReason = recovery
					? "recovery_exhausted"
					: testCase.reason;
				const expectedPayload = {
					error: testCase.error.slice(0, 2000),
					...(expectedReason === undefined ? {} : { reason: expectedReason }),
					...(recovery ? { recovery } : {}),
				};
				assert.deepEqual(failed.payload, expectedPayload);
				assert.equal(
					Object.hasOwn(failed.payload!, "reason"),
					expectedReason !== undefined,
				);
				const serialized: TediRuntimeEvent = JSON.parse(JSON.stringify(failed));
				assert.deepEqual(serialized.payload, expectedPayload);
				assert.equal(
					Object.hasOwn(serialized.payload!, "reason"),
					expectedReason !== undefined,
				);
				if (withProse) {
					assert.deepEqual(events[2]?.payload, {
						role: "assistant",
						content,
						error: testCase.error.slice(0, 2000),
						status: "failed",
					});
				}
			}
		}
	}
}

// Ledger write and outbox failures must not turn provider errors or client ids
// into log content. The full terminal event still reaches the durable outbox.
{
	const runId = buildRunId(TEDI, "private-token-abc123@sample.test", "chat");
	const sensitiveError = new Error(
		"provider saw subject-secret and body-secret",
		{
			cause: new TypeError("login-token-secret"),
		},
	);
	sensitiveError.name = "private-sender@sample.test";
	const logs: Array<{ level: string; values: unknown[] }> = [];
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalError = console.error;
	console.log = (...values: unknown[]) => logs.push({ level: "log", values });
	console.warn = (...values: unknown[]) => logs.push({ level: "warn", values });
	console.error = (...values: unknown[]) =>
		logs.push({ level: "error", values });
	const dropped: TediRuntimeEvent[] = [];
	try {
		await mirrorTurnToLedger({
			platform: {
				async recordRuntimeEvent(event: TediRuntimeEvent) {
					if (event.kind === "message.received")
						throw new Error("nonterminal-raw-secret");
					if (event.kind === "run.completed") throw sensitiveError;
					return {};
				},
			} as unknown as HttpPlatformClient,
			tediId: TEDI,
			conversationId: `${TEDI}:agent:main:secret-conversation`,
			runId,
			userTurn: { content: "user-body-secret", ts: Date.now() },
			assistantTurn: { content: "assistant-body-secret", ts: Date.now() },
			onTerminalDrop: (event) => {
				dropped.push(event);
				throw new Error("outbox-storage-secret");
			},
		});
	} finally {
		console.log = originalLog;
		console.warn = originalWarn;
		console.error = originalError;
	}
	assert.equal(dropped.length, 1);
	assert.equal(dropped[0]?.runId, runId, "durable handoff retains full event");
	assert.equal(logs.filter(({ level }) => level === "warn").length, 3);
	assert.equal(logs.filter(({ level }) => level === "error").length, 2);
	assert.equal(
		logs.some(
			({ values }) =>
				(values[0] as { event?: string }).event === "tedi.ledger.record_failed",
		),
		true,
	);
	for (const { values } of logs) {
		assert.equal(values.length, 1, "each log is one structured record");
		assert.equal(typeof values[0], "object");
	}
	const retry = logs.find(
		({ values }) =>
			(values[0] as { event?: string }).event === "tedi.ledger.record_retry",
	)?.values[0] as { exception: { type: string; cause?: { type: string } } };
	assert.deepEqual(retry.exception, {
		type: "UnknownThrown",
		cause: { type: "TypeError" },
	});
	const logText = JSON.stringify(logs);
	for (const secret of [
		"private-token-abc123@sample.test",
		"private-sender@sample.test",
		"subject-secret",
		"body-secret",
		"login-token-secret",
		"outbox-storage-secret",
		"nonterminal-raw-secret",
	]) {
		assert.equal(logText.includes(secret), false, `${secret} leaked to logs`);
	}
}

console.log("ledger-mirror.test.ts: all assertions passed");
