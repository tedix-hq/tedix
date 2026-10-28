import { describe, expect, it } from "vite-plus/test";
import { readableStepResult, stepConversation } from "./run-step-content";

describe("readable saved step results", () => {
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
