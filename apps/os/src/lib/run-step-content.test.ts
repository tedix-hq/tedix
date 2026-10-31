import { describe, expect, it } from "vite-plus/test";
import type { SkillWorkflowTimelineEvent } from "@tedix/api-contract/schemas/cognitive";
import {
	hasRedaction,
	matchedParentStep,
	parentStepCoordinates,
	presentStepResult,
	readableStepResult,
	stepConversation,
	stepTimestamp,
	recordingNote,
} from "./run-step-content";

describe("readable saved step results", () => {
	it("matches immutable parent and child coordinates without crossing attempts or tools", () => {
		const event = {
			kind: "mcp",
			path: "epochs/2/steps/x:review/4/attempts/3/calls/run/1.json",
			executionEpoch: 2,
			attempt: 3,
			phase: "run",
			name: "review",
			count: 7,
			namespace: "tedi",
			method: "run_tedi_turn",
		} as SkillWorkflowTimelineEvent;
		const parent = {
			kind: "workflow_step_attempt",
			executionEpoch: 2,
			attempt: 3,
			step: { id: "same", name: "review", count: 4 },
			sensitiveOutput: false,
		};
		const child = {
			kind: "workflow_mcp_call",
			executionEpoch: 2,
			attempt: 3,
			phase: "run",
			ordinal: 1,
			step: { id: "same", name: "review", count: 7 },
			namespace: "tedi",
			method: "run_tedi_turn",
		};
		expect(parentStepCoordinates(event)?.path).toBe(
			"epochs/2/steps/x:review/4/attempts/3.json",
		);
		expect(matchedParentStep(event, child, parent)).toBe(true);
		expect(matchedParentStep(event, child, { ...parent, attempt: 2 })).toBe(
			false,
		);
		expect(
			matchedParentStep(event, child, { ...parent, executionEpoch: 1 }),
		).toBe(false);
		expect(
			matchedParentStep(
				event,
				{ ...child, step: { ...child.step, id: "other" } },
				parent,
			),
		).toBe(false);
		expect(
			matchedParentStep(event, { ...child, method: "other" }, parent),
		).toBe(false);
		expect(parentStepCoordinates({ ...event, attempt: 4 })).toBeNull();
	});
	it("keeps substantive search results visible and moves only envelope bookkeeping and recognized suggestions", () => {
		const web = [{ title: "Question", url: "https://example.com" }];
		const tools = [
			{
				provider: "example",
				capability: "search",
				description: "Search provider",
			},
		];
		const result = presentStepResult({
			success: true,
			data: { web, tools },
			id: "internal",
			creditsUsed: 3,
			agent_hints: ["hint"],
		});
		expect(result.content).toEqual({ success: true, data: { web } });
		expect(result.technical).toEqual({
			id: "internal",
			creditsUsed: 3,
			agent_hints: ["hint"],
			suggestedTools: tools,
		});
		const distinct = {
			data: {
				web,
				tools: [{ provider: "x", capability: "y", result: "substantive" }],
			},
		};
		expect(presentStepResult(distinct).content).toEqual(distinct);
		expect(presentStepResult({ id: "meaningful" }).content).toEqual({
			id: "meaningful",
		});
	});
	it("detects nested redaction in arrays and objects", () => {
		expect(hasRedaction({ value: [{ payload: { redacted: true } }] })).toBe(
			true,
		);
		expect(hasRedaction({ value: [{ redacted: false }] })).toBe(false);
	});
	it("formats explicit timestamps without treating identifiers or durations as dates", () => {
		const ms = Date.parse("2026-10-28T09:00:00.000Z");
		expect(stepTimestamp(ms, "timestamp")).toBe("2026-10-28T09:00:00.000Z");
		expect(stepTimestamp(String(ms / 1000), "created_at")).toBe(
			"2026-10-28T09:00:00.000Z",
		);
		expect(stepTimestamp("2026-10-28T09:00:00+01:00")).toBe(
			"2026-10-28T09:00:00+01:00",
		);
		for (const field of [undefined, "id", "durationMs", "position"])
			expect(stepTimestamp(ms, field)).toBeNull();
		expect(stepTimestamp(965, "time")).toBeNull();
		expect(stepTimestamp("not a date", "timestamp")).toBeNull();
		expect(stepTimestamp(Infinity, "timestamp")).toBeNull();
	});
	it("distinguishes loading limits, missing records and unknown recording warnings", () => {
		expect(
			recordingNote(
				"70 R2 artifact body/bodies were omitted after the 128-read inspection limit was reached.",
			),
		).toContain(
			"70 saved records were not loaded because this page reached its loading limit",
		);
		expect(
			recordingNote("2 referenced artifact body/bodies were missing in R2."),
		).toContain("could not be found");
		expect(
			recordingNote(
				"1 R2 artifact body/bodies were unavailable because SKILL_ARTIFACTS is not configured.",
			),
		).toContain("storage is unavailable");
		expect(recordingNote("Unexpected record shape")).toContain(
			"original message",
		);
	});
	it("decodes the saved assistant reply through task and JSON envelopes", () => {
		expect(
			readableStepResult({
				truncated: false,
				value: {
					ok: true,
					value: {
						assistant: { content: '```json\n{"items":[{"fit":0}]}\n```' },
					},
				},
			}),
		).toEqual({ items: [{ fit: 0 }] });
	});
	it("keeps pending acceptance distinct from a final reply", () => {
		expect(
			readableStepResult({
				truncated: false,
				value: { accepted: true, pending: true, assistant: null },
			}),
		).toEqual({ accepted: true, pending: true, assistant: null });
	});
	it("preserves ordinary text fields, malformed JSON and untrusted markup", () => {
		expect(
			readableStepResult({ text: "source quote", confidence: 0.3 }),
		).toEqual({ text: "source quote", confidence: 0.3 });
		expect(readableStepResult("<script>no()</script>")).toBe(
			"<script>no()</script>",
		);
		expect(readableStepResult("{broken")).toBe("{broken");
	});
	it("finds recorded conversation identity without requiring the reply body", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		expect(
			stepConversation({
				value: { runId: `${id}:mcp:judge`, conversationId: "recorded-session" },
			}),
		).toEqual({ tediId: id, conversationId: "recorded-session" });
		expect(
			stepConversation({
				request: { value: { session_key: "recorded-session" } },
				response: { value: { task: { id: `tedi:${id}:${id}:mcp:judge` } } },
			}),
		).toBeNull();
		expect(
			stepConversation({ session_key: "opaque", runId: `${id}:mcp:judge` }),
		).toBeNull();
		expect(stepConversation({ task: { id: "unrelated-task" } })).toBeNull();
	});
});
