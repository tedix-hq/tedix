import { describe, expect, it, vi } from "vite-plus/test";

import { type CspViolationRecord, handleCspReport } from "./csp-report.ts";

const ENDPOINT = "https://os.tedix.dev/csp-report";

/** The violations handed to the sink on its first (and usually only) call. */
function delivered(sink: ReturnType<typeof vi.fn>): CspViolationRecord[] {
	const [violations] = sink.mock.calls[0] as [CspViolationRecord[]];
	return violations;
}

/** First delivered violation, asserting one was actually delivered. */
function firstDelivered(sink: ReturnType<typeof vi.fn>): CspViolationRecord {
	const violation = delivered(sink)[0];
	if (!violation) throw new Error("expected at least one delivered violation");
	return violation;
}

function post(body: unknown, init: RequestInit = {}): Request {
	return new Request(ENDPOINT, {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		...init,
	});
}

/** Reporting API (`report-to`) payload — an array of envelopes. */
function reportingApiPayload(overrides: Record<string, unknown> = {}) {
	return [
		{
			type: "csp-violation",
			age: 0,
			url: "https://os.tedix.dev/",
			user_agent: "Mozilla/5.0 (Test)",
			body: {
				documentURL: "https://os.tedix.dev/chat",
				blockedURL: "inline",
				effectiveDirective: "script-src-elem",
				disposition: "enforce",
				sourceFile: "https://os.tedix.dev/app.js",
				lineNumber: 12,
				columnNumber: 5,
				sample: "alert(1)",
				...overrides,
			},
		},
	];
}

/** Legacy `report-uri` payload — a single kebab-case object. */
function legacyPayload(overrides: Record<string, unknown> = {}) {
	return {
		"csp-report": {
			"document-uri": "https://os.tedix.dev/chat",
			"blocked-uri": "inline",
			"violated-directive": "script-src",
			"effective-directive": "script-src-elem",
			disposition: "enforce",
			"source-file": "https://os.tedix.dev/app.js",
			"line-number": 12,
			"column-number": 5,
			"script-sample": "alert(1)",
			...overrides,
		},
	};
}

describe("handleCspReport", () => {
	it("normalizes a Reporting API report", async () => {
		const sink = vi.fn();
		const response = await handleCspReport(post(reportingApiPayload()), sink);

		expect(response.status).toBe(204);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(firstDelivered(sink)).toEqual({
			documentUrl: "https://os.tedix.dev/chat",
			blockedUrl: "inline",
			effectiveDirective: "script-src-elem",
			disposition: "enforce",
			sourceFile: "https://os.tedix.dev/app.js",
			lineNumber: 12,
			columnNumber: 5,
			sample: "alert(1)",
			userAgent: "Mozilla/5.0 (Test)",
		});
	});

	it("normalizes a legacy report-uri report to the same shape", async () => {
		const sink = vi.fn();
		await handleCspReport(
			post(legacyPayload(), { headers: { "user-agent": "Safari/Test" } }),
			sink,
		);

		const violation = firstDelivered(sink);
		expect(violation.documentUrl).toBe("https://os.tedix.dev/chat");
		expect(violation.effectiveDirective).toBe("script-src-elem");
		// Safari sends no user-agent in the body, so it comes off the request.
		expect(violation.userAgent).toBe("Safari/Test");
	});

	it("falls back to violated-directive when effective-directive is absent", async () => {
		const sink = vi.fn();
		const payload = legacyPayload();
		// biome-ignore lint/performance/noDelete: exercising an absent key
		delete (payload["csp-report"] as Record<string, unknown>)[
			"effective-directive"
		];
		await handleCspReport(post(payload), sink);

		expect(firstDelivered(sink).effectiveDirective).toBe("script-src");
	});

	it("rejects a non-POST with 405", async () => {
		const sink = vi.fn();
		const response = await handleCspReport(
			new Request(ENDPOINT, { method: "GET" }),
			sink,
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
		expect(sink).not.toHaveBeenCalled();
	});

	it("answers 204 on an unparseable body instead of inviting a retry storm", async () => {
		// A non-2xx makes the browser's reporting agent retry with backoff, so a
		// malformed report would become sustained load for no gain.
		const sink = vi.fn();
		const response = await handleCspReport(post("{not json"), sink);

		expect(response.status).toBe(204);
		expect(sink).not.toHaveBeenCalled();
	});

	it("refuses an oversized declared body without reading it", async () => {
		const sink = vi.fn();
		const response = await handleCspReport(
			post(reportingApiPayload(), {
				headers: { "content-length": String(1024 * 1024) },
			}),
			sink,
		);

		expect(response.status).toBe(413);
		expect(sink).not.toHaveBeenCalled();
	});

	it("drops a body that exceeds the cap despite a small content-length", async () => {
		// content-length is advisory; a chunked body can exceed it.
		const sink = vi.fn();
		const response = await handleCspReport(
			post(reportingApiPayload({ sample: "x".repeat(4096) })),
			sink,
			{ maxBodyBytes: 128 },
		);

		expect(response.status).toBe(204);
		expect(sink).not.toHaveBeenCalled();
	});

	it("caps how many reports one payload can deliver", async () => {
		const sink = vi.fn();
		const many = Array.from({ length: 50 }, () => reportingApiPayload()[0]);
		await handleCspReport(post(many), sink, { maxReports: 5 });

		expect(delivered(sink)).toHaveLength(5);
	});

	it("truncates long fields", async () => {
		const sink = vi.fn();
		await handleCspReport(
			post(reportingApiPayload({ sample: "y".repeat(4096) })),
			sink,
			{ maxFieldLength: 32 },
		);

		expect(firstDelivered(sink).sample).toHaveLength(32);
	});

	it("drops a report about a document on another host", async () => {
		const sink = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = await handleCspReport(
			post(reportingApiPayload({ documentURL: "https://evil.example/x" })),
			sink,
		);

		expect(response.status).toBe(204);
		expect(sink).not.toHaveBeenCalled();
		// Counted out loud: a proxy rewriting the host would otherwise discard
		// every report while looking identical to "no violations".
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("ignores a non-CSP report type on the shared reporting endpoint", async () => {
		// Reporting API groups can carry deprecation/intervention reports too.
		const sink = vi.fn();
		await handleCspReport(
			post([{ type: "deprecation", url: ENDPOINT, body: { id: "x" } }]),
			sink,
		);

		expect(sink).not.toHaveBeenCalled();
	});

	it("does not fail the request when the sink throws", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await handleCspReport(post(reportingApiPayload()), () => {
			throw new Error("analytics down");
		});

		expect(response.status).toBe(204);
		error.mockRestore();
	});
});
