import { describe, expect, it } from "vite-plus/test";
import { chunkAnswerForDelivery } from "./answer-delivery";

describe("chunkAnswerForDelivery", () => {
	it("splits on word boundaries and round-trips the text", () => {
		const text =
			"On it — delegating to CTO now. I'll bring CTO's result back here when it's done.";
		const chunks = chunkAnswerForDelivery(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(text);
		for (const chunk of chunks.slice(0, -1)) expect(chunk).toMatch(/\s$/);
	});

	it("returns no chunks for empty text", () => {
		expect(chunkAnswerForDelivery("")).toEqual([]);
	});
});
