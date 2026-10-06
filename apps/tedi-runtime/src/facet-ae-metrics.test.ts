/**
 * Facet-fleet Analytics Engine observability. Console lines get sampled away
 * under load, so AE datapoints are the queryable record for facet latency and
 * dangling-turn counts: every facet turn path emits on BOTH outcomes, and
 * emission is fail-soft (never throws into a turn).
 */
import assert from "node:assert/strict";
import { facetRunnerProbe, tediDo } from "../test/tedi-do";

// --- emission is fail-soft behind an optional binding ---
{
	const written: unknown[] = [];
	tediDo({
		state: { tediId: "tedi-1" },
		env: {
			RUNTIME_ANALYTICS: {
				writeDataPoint: (point: unknown) => written.push(point),
			},
		},
	}).emitFacetTurnDatapoint({ surface: "mcp", outcome: "complete" });
	assert.equal(written.length, 1);
	for (const env of [
		{},
		{
			RUNTIME_ANALYTICS: {
				writeDataPoint() {
					throw new Error("AE unavailable");
				},
			},
		},
	]) {
		tediDo({ state: {}, env }).emitFacetTurnDatapoint({
			surface: "mcp",
			outcome: "complete",
		});
	}
}

// --- every facet surface emits a complete AND an error datapoint ---
const conversationInput = {
	sessionKey: "main",
	guardedUserText: "hello",
	userTs: 1,
	system: "SYSTEM",
	runId: "run-1",
	maxSteps: 8,
	tools: {},
};
const streamInput = {
	sessionKey: "main",
	userText: "hello",
	userTs: 1,
	system: "SYSTEM",
	runId: "run-1",
	maxSteps: 8,
	tools: {},
	onDelta() {},
};
const done = JSON.stringify({
	kind: "done",
	requestId: "r",
	text: "answer",
	turnCount: 1,
	turnMs: 1,
});
const surfaces: Array<{
	surface: string;
	run: (probe: ReturnType<typeof facetRunnerProbe>) => Promise<unknown>;
}> = [
	{
		surface: "mcp",
		run: (probe) =>
			probe.agent.runConversationFacetTurn({
				...conversationInput,
				surface: "mcp",
			}),
	},
	{
		surface: "email",
		run: (probe) =>
			probe.agent.runConversationFacetTurn({
				...conversationInput,
				surface: "email",
			}),
	},
	{
		surface: "sse",
		run: (probe) => probe.agent.streamConversationFacetTurn(streamInput),
	},
	{
		surface: "judge",
		run: (probe) =>
			probe.agent.runJudgeFacetTurn({
				sessionKey: "evidence:judge:1",
				runId: "judge-run-1",
				guardedUserText: "claim",
				userTs: 1,
			}),
	},
];
for (const { surface, run } of surfaces) {
	for (const fail of [false, true]) {
		const probe = facetRunnerProbe({ fail, stream: [done] });
		await run(probe);
		assert.deepEqual(
			probe.datapoints.map((point) => [point.surface, point.outcome]),
			[[surface, fail ? "error" : "complete"]],
			`${surface} ${fail ? "error" : "complete"}`,
		);
	}
}

// --- SSE's non-throwing error returns also emit ---
for (const [stream, errorClass] of [
	[
		[JSON.stringify({ kind: "error", message: "boom" })],
		"FacetStreamErrorFrame",
	],
	[
		[JSON.stringify({ kind: "delta", text: "partial" })],
		"FacetStreamNoTerminalFrame",
	],
] as const) {
	const probe = facetRunnerProbe({ stream: [...stream] });
	const result = await probe.agent.streamConversationFacetTurn(streamInput);
	assert.ok(result.turnError);
	assert.deepEqual(
		probe.datapoints.map((point) => [point.outcome, point.errorClass]),
		[["error", errorClass]],
	);
}

// --- dangling-turn detection emits a fail-soft datapoint ---
{
	const written: unknown[] = [];
	const staleUserTurn = {
		role: "user",
		content: "still waiting",
		sessionKey: "main",
		ts: Date.now() - 60 * 60 * 1000,
	};
	for (const writeDataPoint of [
		(point: unknown) => written.push(point),
		() => {
			throw new Error("AE unavailable");
		},
	]) {
		tediDo({
			state: { tediId: "tedi-1" },
			env: { RUNTIME_ANALYTICS: { writeDataPoint } },
			sessionRepo: { listTurns: () => [staleUserTurn] },
		}).logDanglingTurnIfAny("main", "runDurableChatTurn");
	}
	assert.equal(written.length, 1);
}

console.log("facet-ae-metrics OK");
