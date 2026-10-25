import { describe, expect, it } from "vite-plus/test";
import {
	TRANSCRIPT_TRANSIENT_RETRIES,
	transientTranscriptRetryMs,
} from "./chat-polling";

describe("transientTranscriptRetryMs", () => {
	const unavailable = {
		status: 503,
		code: "SERVICE_UNAVAILABLE",
		message: "Organization identity is temporarily unavailable",
	};

	it("re-reads a transcript after a transient failure with bounded backoff", () => {
		expect(transientTranscriptRetryMs(unavailable, 1)).toBe(2_000);
		expect(transientTranscriptRetryMs(unavailable, 2)).toBe(4_000);
		expect(transientTranscriptRetryMs({ code: "SERVICE_UNAVAILABLE" }, 3)).toBe(
			8_000,
		);
		expect(transientTranscriptRetryMs(unavailable, 6)).toBe(30_000);
		expect(
			transientTranscriptRetryMs(unavailable, TRANSCRIPT_TRANSIENT_RETRIES + 1),
		).toBe(false);
	});

	it("leaves other failures to the explicit error state", () => {
		expect(
			transientTranscriptRetryMs({ status: 403, code: "FORBIDDEN" }, 1),
		).toBe(false);
		expect(transientTranscriptRetryMs(new Error("boom"), 1)).toBe(false);
		expect(transientTranscriptRetryMs(null, 1)).toBe(false);
	});
});
