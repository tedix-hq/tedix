import { describe, expect, it } from "vite-plus/test";
import { maybeHandleBootstrapFastMcp } from "./codemode-fast-paths";
import { readJsonRpcEnvelope } from "./json-rpc-envelope";

const MAX_BYTES = 4 * 1024 * 1024;

describe("MCP request body limit", () => {
	it("returns 413 for chunked overflow while the original tee branch remains unread and open", async () => {
		let source!: ReadableStreamDefaultController<Uint8Array>;
		let sourceCancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
				controller.enqueue(new Uint8Array(MAX_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel() {
				sourceCancelled = true;
			},
		});
		const request = new Request("https://sample.example/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: stream,
			duplex: "half",
		} as RequestInit);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				maybeHandleBootstrapFastMcp(request, {} as never),
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), 250);
				}),
			]);
			expect(result?.status).toBe(413);
			expect(request.bodyUsed).toBe(false);
			expect(sourceCancelled).toBe(false);
			expect(await result?.json()).toMatchObject({
				error: { message: expect.stringContaining("4194304") },
			});
		} finally {
			clearTimeout(timer);
			source.close();
			await request.body?.cancel();
		}
	});

	it("accepts a valid envelope exactly at the byte limit", async () => {
		const prefix = '{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"';
		const suffix = '"}';
		const body =
			prefix + " ".repeat(MAX_BYTES - prefix.length - suffix.length) + suffix;
		const request = new Request("https://sample.example/mcp", {
			method: "POST",
			body,
		});
		expect(await readJsonRpcEnvelope(request)).toMatchObject({
			body: { method: "tools/list", id: 1 },
		});
	});
});
