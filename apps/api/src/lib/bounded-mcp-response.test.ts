import { describe, expect, it, vi } from "vite-plus/test";
import {
	boundMcpResponse,
	MAX_MCP_RESPONSE_BYTES,
} from "./bounded-mcp-response";

describe("upstream MCP memory bound", () => {
	it("cancels advertised oversized bodies without reading them", async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }), {
			headers: { "Content-Length": String(MAX_MCP_RESPONSE_BYTES + 1) },
		});
		await expect(boundMcpResponse(response)).rejects.toThrow(
			"MCP response exceeds",
		);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it.each(["application/json", "text/event-stream"])(
		"bounds unadvertised %s before parsing",
		async (contentType) => {
			const cancel = vi.fn();
			let chunks = 0;
			const response = await boundMcpResponse(
				new Response(
					new ReadableStream({
						pull(controller) {
							chunks++;
							controller.enqueue(new Uint8Array(1024 * 1024));
						},
						cancel,
					}),
					{ headers: { "Content-Type": contentType } },
				),
			);
			await expect(response.arrayBuffer()).rejects.toThrow(
				"MCP response exceeds",
			);
			expect(cancel).toHaveBeenCalledOnce();
			expect(chunks).toBeLessThanOrEqual(6);
		},
	);
	it("preserves a bounded result and headers", async () => {
		const response = await boundMcpResponse(
			new Response('{"result":{}}', {
				headers: { "Content-Type": "application/json" },
			}),
		);
		expect(await response.json()).toEqual({ result: {} });
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});
});
