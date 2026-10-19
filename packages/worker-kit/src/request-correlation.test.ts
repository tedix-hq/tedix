import { describe, expect, it } from "vite-plus/test";
import {
	correlatedRequest,
	correlatedErrorResponse,
} from "./request-correlation";

const traceId = "11111111-1111-4111-8111-111111111111";
describe("request correlation", () => {
	it("preserves valid upstream context and replaces arbitrary header content", () => {
		const request = new Request("https://example.test/rpc", {
			headers: { "X-Tedix-Trace-Id": traceId },
		});
		expect(correlatedRequest(request).traceId).toBe(traceId);
		const invalid = correlatedRequest(
			new Request(request, {
				headers: { "X-Trace-Id": "private customer text" },
			}),
		);
		expect(invalid.traceId).toMatch(/^[a-f0-9-]{36}$/);
		expect(invalid.request.headers.get("X-Trace-Id")).toBe(invalid.traceId);
	});
	it("uses the same UUID representation as the existing W3C bridge", () => {
		const parent = `00-${traceId.replaceAll("-", "")}-1111111111111111-01`;
		expect(
			correlatedRequest(
				new Request("https://example.test", {
					headers: { traceparent: parent },
				}),
			).traceId,
		).toBe(traceId);
	});
	it("preserves oRPC error data, status and headers while exposing a support reference", async () => {
		const response = await correlatedErrorResponse(
			Response.json(
				{
					json: {
						defined: false,
						code: "SERVICE_UNAVAILABLE",
						message: "Slow",
						data: { retryAfter: 30 },
					},
				},
				{ status: 503, headers: { "Retry-After": "30" } },
			),
			traceId,
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("30");
		expect(response.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
		expect(await response.json()).toMatchObject({
			json: { code: "SERVICE_UNAVAILABLE", data: { retryAfter: 30, traceId } },
		});
	});
	it("correlates ordinary JSON and non-JSON errors without touching successful streams", async () => {
		const json = await correlatedErrorResponse(
			Response.json({ error: "unavailable" }, { status: 503 }),
			traceId,
		);
		expect(await json.json()).toEqual({ error: "unavailable" });
		expect(json.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
		const html = await correlatedErrorResponse(
			new Response("unavailable", { status: 502 }),
			traceId,
		);
		expect(await html.text()).toBe("unavailable");
		expect(html.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
		const success = new Response("stream", {
			headers: { "Content-Type": "text/event-stream" },
		});
		expect(await correlatedErrorResponse(success, traceId)).toBe(success);
	});
});
