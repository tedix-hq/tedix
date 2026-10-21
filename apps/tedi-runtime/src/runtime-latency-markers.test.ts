import assert from "node:assert/strict";
import * as markers from "./runtime-latency-markers";

const extras = {
	prompt: "SYNTHETIC_FORBIDDEN_PROMPT",
	toolResult: "SYNTHETIC_FORBIDDEN_TOOL_RESULT",
	token: "SYNTHETIC_FORBIDDEN_TOKEN",
	_tr: "SYNTHETIC_FORGED_DISCRIMINATOR",
};

function markerCase<T extends object>(
	name: keyof typeof markers,
	marker: (input: T) => void,
	input: T,
	discriminator: string,
	nullableFields: (keyof T)[],
) {
	return {
		name,
		check: () => {
			const lines: string[] = [];
			const originalLog = console.log;
			const capture = (line: string) => lines.push(line);
			console.log = capture;
			const expected = { _tr: discriminator, ...input };
			const assertLine = (value: object) => {
				assert.equal(lines.length, 1);
				const line = lines.pop()!;
				assert.deepEqual(JSON.parse(line), value);
				for (const forbidden of Object.values(extras)) {
					assert.equal(line.includes(forbidden), false);
				}
			};
			try {
				marker(input);
				assertLine(expected);
				marker({ ...input, ...extras });
				assertLine(expected);

				const nulls = Object.fromEntries(
					nullableFields.map((field) => [field, null]),
				);
				marker({ ...input, ...nulls });
				assertLine({ ...expected, ...nulls });

				const wider = { ...input };
				for (const field of [...Object.keys(extras), "toJSON"]) {
					Object.defineProperty(wider, field, {
						enumerable: true,
						get: () => {
							throw new Error("undeclared getter must not be read");
						},
					});
				}
				assert.doesNotThrow(() => marker(wider));
				assertLine(expected);

				for (const field of Object.keys(input)) {
					const hostile = { ...input };
					Object.defineProperty(hostile, field, {
						get: () => {
							throw new Error("declared getter failed");
						},
					});
					assert.doesNotThrow(() => marker(hostile));
					assert.equal(lines.length, 0);
				}

				const circular: { self?: unknown } = {};
				circular.self = circular;
				for (const value of [
					circular,
					{
						toJSON() {
							throw new Error("serialization failed");
						},
					},
				]) {
					const hostile = { ...input };
					Object.defineProperty(hostile, Object.keys(input)[0]!, { value });
					assert.doesNotThrow(() => marker(hostile));
					assert.equal(lines.length, 0);
				}

				console.log = () => {
					throw new Error("logger failed");
				};
				assert.doesNotThrow(() => marker(input));
				console.log = capture;
				marker(input);
				assertLine(expected);
			} finally {
				console.log = originalLog;
			}
		},
	};
}

const cases = [
	markerCase(
		"markFacetToolDispatch",
		markers.markFacetToolDispatch,
		{
			tediId: "tedi-example",
			runId: "run-example",
			toolCallId: "call-example",
			tool: "read",
			calleeMs: 12.5,
			authorityMs: 0,
			executeMs: 9,
			finishReason: "complete",
		},
		"facet_tool_dispatch",
		["tediId"],
	),
	markerCase(
		"markStepCompleted",
		markers.markStepCompleted,
		{
			tediId: "tedi-example",
			runId: "run-example",
			stepNumber: 0,
			finishReason: "stop",
			durationMs: 12.5,
			inputTokens: 123,
			outputTokens: 0,
		},
		"step",
		["finishReason", "durationMs", "inputTokens", "outputTokens"],
	),
	markerCase(
		"markInferenceAuthorize",
		markers.markInferenceAuthorize,
		{
			runId: "run-example",
			provider: "example-provider",
			model: "example-model",
			source: "system",
			parseMs: 0,
			rpcMs: 2.5,
			totalMs: 3,
			estimatedInputTokens: 123,
			outcome: "authorized",
		},
		"inference_authorize",
		["runId", "source", "estimatedInputTokens"],
	),
	markerCase(
		"markFacetToolWait",
		markers.markFacetToolWait,
		{
			runId: "run-example",
			toolCallId: "call-example",
			tool: "read",
			waitMs: 2.5,
			resolveMs: 0,
		},
		"facet_tool_wait",
		["runId"],
	),
	markerCase(
		"markStepFinish",
		markers.markStepFinish,
		{
			runId: "run-example",
			accountingMs: 0,
			telemetryMs: 2.5,
			totalMs: 3,
		},
		"facet_step_finish",
		["runId"],
	),
	markerCase(
		"markStepPrepare",
		markers.markStepPrepare,
		{
			runId: "run-example",
			reconcileMs: 0,
			reserveMs: 2.5,
			totalMs: 3,
		},
		"facet_step_prepare",
		["runId"],
	),
	markerCase(
		"markToolCall",
		markers.markToolCall,
		{
			tediId: "tedi-example",
			runId: "run-example",
			toolName: "read",
			toolCallId: "call-example",
			stepNumber: 0,
			turnPrincipalId: "principal-example",
			turnSurface: "sse",
		},
		"tool.call",
		["tediId", "runId", "stepNumber", "turnPrincipalId", "turnSurface"],
	),
];

assert.deepEqual(
	cases.map(({ name }) => name).sort(),
	Object.keys(markers).sort(),
);
for (const testCase of cases) testCase.check();
console.log(
	"PASS: every latency marker projects declared fields and remains best-effort",
);
