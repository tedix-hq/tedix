import { describe, expect, it } from "vite-plus/test";
import { episodeTraceId } from "./episode-trace";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";

describe("episodeTraceId", () => {
	it("accepts W3C traceparent headers for API episode joins", () => {
		expect(episodeTraceId(new Headers({ traceparent: TRACEPARENT }))).toBe(
			TRACE_UUID,
		);
	});

	it("keeps the legacy MCP and brain-bridge header fallbacks", () => {
		expect(
			episodeTraceId(
				new Headers({
					"X-Trace-Id": "mcp-trace",
					"X-Tedix-Trace-Id": "brain-bridge-trace",
				}),
			),
		).toBe("mcp-trace");
		expect(
			episodeTraceId(new Headers({ "X-Tedix-Trace-Id": "brain-bridge-trace" })),
		).toBe("brain-bridge-trace");
	});

	it("omits trace metadata instead of inventing orphan episode ids", () => {
		expect(episodeTraceId(new Headers())).toBeUndefined();
		expect(episodeTraceId(new Headers({ "X-Trace-Id": " " }))).toBeUndefined();
	});
});
