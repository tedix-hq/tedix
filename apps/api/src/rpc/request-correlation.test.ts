import { describe, expect, it } from "vite-plus/test";
import { requestCorrelation } from "./request-correlation";

const id = "5eed0006-0000-4000-8000-000000000006";

describe("requestCorrelation", () => {
	it("joins forwarded execution lineage without retaining other headers", () => {
		const headers = new Headers({
			"X-Tedix-Trace-Id": id,
			"X-Tedix-Mcp-Execution-Id": id,
			"X-Tedix-Kernel-Run-Id": id,
			"X-Tedix-Work-Item-Id": id,
			"X-Tedix-Trace-Bundle-Id": id,
			authorization: "Bearer secret",
			cookie: "session=secret",
		});
		expect(requestCorrelation(headers)).toEqual({
			traceId: id,
			mcpExecutionId: id,
			kernelRunId: id,
			workItemId: id,
			traceBundleId: id,
		});
	});
	it("uses canonical W3C precedence over legacy headers", () => {
		expect(
			requestCorrelation(
				new Headers({
					traceparent:
						"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
					"X-Trace-Id": id,
					"X-Tedix-Trace-Id": id,
				}),
			),
		).toEqual({ traceId: "01234567-89ab-cdef-0123-456789abcdef" });
	});
	it("omits missing, malformed and oversized caller-controlled values", () => {
		expect(requestCorrelation(undefined)).toEqual({});
		expect(
			requestCorrelation(
				new Headers({
					"X-Trace-Id": "Bearer secret",
					"X-Tedix-Mcp-Execution-Id": "a".repeat(5000),
					"X-Tedix-Work-Item-Id": "https://user:password@example.com",
					"X-Tedix-Kernel-Run-Id": id + "," + id,
					"X-Tedix-Trace-Bundle-Id": "secret",
				}),
			),
		).toEqual({});
	});
});
