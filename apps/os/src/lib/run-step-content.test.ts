import { describe, expect, it } from "vite-plus/test";
import {
	readableStepResult,
	stepConversation,
	stepTimestamp,
	recordingNote,
} from "./run-step-content";

describe("readable saved step results", () => {
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
		).toEqual({ tediId: id, conversationId: "recorded-session" });
		expect(stepConversation({ task: { id: "unrelated-task" } })).toBeNull();
	});
});
