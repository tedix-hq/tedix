import { describe, expect, it } from "vite-plus/test";
import {
	extractMcpTraceMeta,
	formatTraceparent,
	inboundTraceIdFromHeaders,
	outboundTraceMeta,
	parseTraceparentTraceId,
	randomSpanId,
	resolveInboundTraceId,
	resolveInboundTracestate,
} from "./trace-context";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";

describe("parseTraceparentTraceId", () => {
	it("extracts the trace-id as a UUID", () => {
		expect(parseTraceparentTraceId(TP)).toBe(TRACE_UUID);
	});
	it("is case-insensitive and trims", () => {
		expect(parseTraceparentTraceId(`  ${TP.toUpperCase()} `)).toBe(TRACE_UUID);
	});
	it("rejects malformed / absent / all-zero trace-id", () => {
		expect(parseTraceparentTraceId(null)).toBeNull();
		expect(parseTraceparentTraceId("nope")).toBeNull();
		expect(parseTraceparentTraceId("00-bad-bad-01")).toBeNull();
		expect(
			parseTraceparentTraceId(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`),
		).toBeNull();
	});
});

describe("formatTraceparent", () => {
	it("round-trips a UUID traceId into a valid traceparent", () => {
		const tp = formatTraceparent(TRACE_UUID, { spanId: "00f067aa0ba902b7" });
		expect(tp).toBe(TP);
		// and parses back to the same trace id
		expect(parseTraceparentTraceId(tp)).toBe(TRACE_UUID);
	});
	it("accepts a bare 32-hex traceId", () => {
		expect(formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736")).toMatch(
			/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
		);
	});
	it("honors sampled=false", () => {
		expect(formatTraceparent(TRACE_UUID, { spanId: "0".repeat(16) })).toMatch(
			/-01$/,
		);
		expect(
			formatTraceparent(TRACE_UUID, { spanId: "a".repeat(16), sampled: false }),
		).toMatch(/-00$/);
	});
	it("returns null for a non-hex traceId", () => {
		expect(formatTraceparent("not-a-trace")).toBeNull();
	});
});

describe("randomSpanId", () => {
	it("is 16 hex and non-zero", () => {
		const s = randomSpanId();
		expect(s).toMatch(/^[0-9a-f]{16}$/);
		expect(s).not.toBe("0".repeat(16));
	});
});

describe("extractMcpTraceMeta", () => {
	it("extracts params._meta from a single JSON-RPC request", () => {
		const meta = extractMcpTraceMeta({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "x", _meta: { traceparent: TP, tracestate: "vendor=1" } },
		});
		expect(meta).toEqual({ traceparent: TP, tracestate: "vendor=1" });
	});

	it("ignores batches, missing params, and non-object _meta", () => {
		expect(extractMcpTraceMeta([])).toBeUndefined();
		expect(extractMcpTraceMeta({ params: undefined })).toBeUndefined();
		expect(
			extractMcpTraceMeta({ params: { _meta: "not-an-object" } }),
		).toBeUndefined();
	});
});

describe("inboundTraceIdFromHeaders", () => {
	it("prefers W3C traceparent over legacy headers", () => {
		const h = new Headers({
			traceparent: TP,
			"x-trace-id": "legacy-id",
			"x-tedix-trace-id": "brain-bridge-id",
		});
		expect(inboundTraceIdFromHeaders(h)).toBe(TRACE_UUID);
	});

	it("falls back to X-Trace-Id then X-Tedix-Trace-Id", () => {
		expect(
			inboundTraceIdFromHeaders(new Headers({ "x-trace-id": " legacy-id " })),
		).toBe("legacy-id");
		expect(
			inboundTraceIdFromHeaders(
				new Headers({ "x-tedix-trace-id": " brain-bridge-id " }),
			),
		).toBe("brain-bridge-id");
	});

	it("returns undefined instead of inventing an orphan trace id", () => {
		expect(inboundTraceIdFromHeaders(new Headers())).toBeUndefined();
		expect(
			inboundTraceIdFromHeaders(new Headers({ "x-trace-id": " " })),
		).toBeUndefined();
	});
});

describe("resolveInboundTraceId", () => {
	it("prefers W3C traceparent over X-Trace-Id", () => {
		const h = new Headers({ traceparent: TP, "x-trace-id": "legacy-id" });
		expect(resolveInboundTraceId(h)).toBe(TRACE_UUID);
	});
	it("prefers W3C traceparent header over MCP _meta traceparent", () => {
		const h = new Headers({
			traceparent: TP,
			"x-trace-id": "legacy-id",
		});
		expect(
			resolveInboundTraceId(h, {
				traceparent: "00-11111111111111111111111111111111-00f067aa0ba902b7-01",
			}),
		).toBe(TRACE_UUID);
	});
	it("falls back to MCP _meta traceparent before X-Trace-Id", () => {
		const h = new Headers({ "x-trace-id": "legacy-id" });
		expect(resolveInboundTraceId(h, { traceparent: TP })).toBe(TRACE_UUID);
	});
	it("falls back to X-Trace-Id", () => {
		const h = new Headers({ "x-trace-id": "legacy-id" });
		expect(resolveInboundTraceId(h)).toBe("legacy-id");
	});
	it("generates a UUID when neither present", () => {
		expect(resolveInboundTraceId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("resolveInboundTracestate", () => {
	it("prefers HTTP tracestate over MCP _meta tracestate", () => {
		const h = new Headers({ tracestate: "vendor=header" });
		expect(resolveInboundTracestate(h, { tracestate: "vendor=meta" })).toBe(
			"vendor=header",
		);
	});

	it("falls back to MCP _meta tracestate", () => {
		expect(
			resolveInboundTracestate(new Headers(), { tracestate: " vendor=meta " }),
		).toBe("vendor=meta");
	});

	it("ignores missing, blank, and non-string tracestate", () => {
		expect(resolveInboundTracestate(new Headers())).toBeUndefined();
		expect(
			resolveInboundTracestate(new Headers(), { tracestate: " " }),
		).toBeUndefined();
		expect(
			resolveInboundTracestate(new Headers(), { tracestate: 123 }),
		).toBeUndefined();
	});
});

describe("outboundTraceMeta", () => {
	it("emits a traceparent for a valid traceId", () => {
		const meta = outboundTraceMeta(TRACE_UUID);
		expect(meta.traceparent).toMatch(
			/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
		);
	});
	it("merges tracestate when given", () => {
		expect(outboundTraceMeta(TRACE_UUID, "vendor=1").tracestate).toBe(
			"vendor=1",
		);
	});
	it("returns empty for missing/invalid traceId (safe to spread)", () => {
		expect(outboundTraceMeta(undefined)).toEqual({});
		expect(outboundTraceMeta("not-hex")).toEqual({});
	});
});
