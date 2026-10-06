/**
 * Unit tests for voice helper functions.
 *
 * Tests cover:
 *   voiceShapeResult — requires_approval, empty content, plain content passthrough
 *
 * Imports from voice-helpers.ts (pure functions, no cloudflare: protocol deps).
 */

import { describe, expect, it } from "vite-plus/test";
import { voiceShapeResult } from "./voice-helpers";

// ---------------------------------------------------------------------------
// Minimal KernelTurnWorkResult stubs
// ---------------------------------------------------------------------------

function makeResult(
	status: string,
	content: string,
): Parameters<typeof voiceShapeResult>[0] {
	return {
		status,
		assistantMessage: { content },
	} as Parameters<typeof voiceShapeResult>[0];
}

// ---------------------------------------------------------------------------
// 1. voiceShapeResult
// ---------------------------------------------------------------------------

describe("voiceShapeResult", () => {
	it("requires_approval → approval spoken line", () => {
		const result = makeResult("requires_approval", "you should approve this");
		expect(voiceShapeResult(result)).toBe(
			"That change needs your approval — the request is in your Home feed.",
		);
	});

	it("empty assistantMessage content → queued ack line", () => {
		const result = makeResult("done", "   ");
		expect(voiceShapeResult(result)).toBe(
			"I'm still working on that — the result will land in your Home feed.",
		);
	});

	it("non-empty content → passthrough (trimmed)", () => {
		const result = makeResult("done", "  The deploy completed successfully.  ");
		expect(voiceShapeResult(result)).toBe("The deploy completed successfully.");
	});

	it("requires_approval takes priority over non-empty content", () => {
		const result = makeResult("requires_approval", "non-empty content here");
		expect(voiceShapeResult(result)).toBe(
			"That change needs your approval — the request is in your Home feed.",
		);
	});
});
