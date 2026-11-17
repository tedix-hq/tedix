import { describe, expect, test } from "bun:test";
import { boundedEventInput, EVENT_INPUT_CHARS } from "./event-ledger";

describe("boundedEventInput", () => {
	test("keeps a small payload as it is", () => {
		const input = { outputId: "o1", patch: "short" };
		expect(boundedEventInput(input)).toEqual(input);
		expect(boundedEventInput(undefined)).toBeUndefined();
	});

	test("replaces a 1.2 MB save with a small summary in each event", () => {
		const input = { outputId: "o1", content: "x".repeat(1_200_000) };
		const stored = JSON.stringify(boundedEventInput(input));
		expect(stored.length).toBeLessThan(EVENT_INPUT_CHARS);
		expect(JSON.parse(stored)).toEqual({
			truncated: true,
			chars: JSON.stringify(input).length,
			keys: ["outputId", "content"],
		});
		// Two events (step.started + approval.requested) now cost under 4 KB.
		expect(stored.length * 2).toBeLessThan(4_000);
	});
});
