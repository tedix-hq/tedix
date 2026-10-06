import { describe, expect, it } from "vite-plus/test";
import {
	DerivedRuntimeEventEnvelopeSchema,
	derivedRuntimeEventKey,
} from "./derived-events";

const valid = {
	version: 1 as const,
	type: "tedix.runtime-event.derived" as const,
	eventId: "run-1:tool.1.completed",
	tediId: "tedi-1",
	runId: "run-1",
	kind: "tool.completed",
	sequence: 3,
	occurredAt: "2026-10-01T12:00:00.000Z",
	runtimeBackend: "cloudflare-agents",
};

describe("DerivedRuntimeEventEnvelopeSchema", () => {
	it("accepts the versioned payload-free projection", () => {
		expect(DerivedRuntimeEventEnvelopeSchema.parse(valid)).toEqual(valid);
		expect(derivedRuntimeEventKey(valid)).toBe(
			"runtime-event:v1:run-1:tool.1.completed",
		);
	});

	it("rejects payload fields so ledger content cannot leak into K2", () => {
		expect(() =>
			DerivedRuntimeEventEnvelopeSchema.parse({
				...valid,
				payload: { arguments: { token: "secret" } },
			}),
		).toThrow();
	});

	it("rejects unknown versions", () => {
		expect(() =>
			DerivedRuntimeEventEnvelopeSchema.parse({ ...valid, version: 2 }),
		).toThrow();
	});
});
