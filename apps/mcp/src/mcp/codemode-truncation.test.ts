/**
 * Regression coverage for detectable Code Mode result truncation.
 *
 * The old behavior silently degraded an oversized STRUCTURED `code` result
 * into a clipped JSON STRING (via @cloudflare/codemode's `truncateResult`),
 * which downstream parsers treated as an empty result — two real production
 * bugs (phantom "empty list" pages, live-broken board id resolver). The
 * gateway now emits a structured `__tedix_truncated` envelope instead; a
 * within-budget result passes through byte-identical.
 */

import {
	isTruncatedCodeModeResult,
	type TruncatedCodeModeResult,
} from "@tedix/tedi-codemode-core/bounded-result";
import { describe, expect, it } from "vite-plus/test";
import { shapeCodeModeResultForModel } from "./codemode";

function oversizedBoardPage(rows = 400): { data: Record<string, unknown>[] } {
	return {
		data: Array.from({ length: rows }, (_, i) => ({
			id: `31090c72-e6eb-4bc1-b3a1-4d799845${String(i).padStart(4, "0")}`,
			title: `work item ${i} with a long descriptive title carrying detail`,
			description: "long description body ".repeat(12),
			status: "accepted",
			priority: "medium",
		})),
	};
}

describe("shapeCodeModeResultForModel", () => {
	it("passes a within-budget structured result through byte-identical", () => {
		const value = { data: [{ id: "a", title: "small page" }] };
		expect(shapeCodeModeResultForModel(value)).toBe(value);
	});

	it("surfaces an oversized structured result as a DETECTABLE envelope, never a bare clipped string", () => {
		const value = oversizedBoardPage();
		expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(24_000);

		const shaped = shapeCodeModeResultForModel(value);
		// The silent failure mode: typeof === "string" with clipped JSON inside.
		expect(typeof shaped).not.toBe("string");
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		const envelope = shaped as TruncatedCodeModeResult;
		expect(envelope.maxTokens).toBe(6_000);
		expect(envelope.approxTokens).toBeGreaterThan(6_000);
		expect(envelope.guidance).toContain("Narrow the projection");
		expect(typeof envelope.preview).toBe("string");
	});

	it("honors the per-app codeModeResultMaxTokens override plumbing", () => {
		const value = oversizedBoardPage(40);
		// Under the default budget this page passes through untouched…
		expect(shapeCodeModeResultForModel(value)).toBe(value);
		// …but a stricter per-app budget truncates it detectably.
		const shaped = shapeCodeModeResultForModel(value, { maxTokens: 200 });
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		expect((shaped as TruncatedCodeModeResult).maxTokens).toBe(200);
	});
});
