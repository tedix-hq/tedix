import { describe, expect, test } from "vite-plus/test";
import { readSiteBuilderRpcEnvelope } from "./site-builder-rpc";

function sse(body: string, status = 200): Response {
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
		status,
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

describe("readSiteBuilderRpcEnvelope", () => {
	test("reads a result out of an SSE-framed 200", async () => {
		// Site Builder runs mountMcp with responseMode "auto", so a successful
		// tools/list comes back as `event: message\ndata: {...}`. Parsing that
		// body as flat JSON turned every 200 into a synthetic error.
		const envelope = await readSiteBuilderRpcEnvelope(
			sse(
				'event: message\ndata: {"jsonrpc":"2.0","id":"req-1","result":{"tools":[{"name":"theme_list_files"}]}}\n\n',
			),
			"req-1",
		);
		expect(envelope.error).toBeUndefined();
		expect(envelope.result).toEqual({ tools: [{ name: "theme_list_files" }] });
	});

	test("skips notification frames emitted ahead of the result", async () => {
		// `auto` upgrades the POST precisely because the handler emitted a
		// related message first, so the FIRST data frame is not always the answer.
		const envelope = await readSiteBuilderRpcEnvelope(
			sse(
				[
					"event: message",
					'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
					"",
					"event: message",
					'data: {"jsonrpc":"2.0","id":"req-7","result":{"ok":true}}',
					"",
				].join("\n"),
			),
			"req-7",
		);
		expect(envelope.result).toEqual({ ok: true });
	});

	test("picks the frame matching the request id", async () => {
		const envelope = await readSiteBuilderRpcEnvelope(
			sse(
				[
					'data: {"jsonrpc":"2.0","id":"other","result":{"wrong":true}}',
					'data: {"jsonrpc":"2.0","id":"mine","result":{"right":true}}',
					"",
				].join("\n"),
			),
			"mine",
		);
		expect(envelope.result).toEqual({ right: true });
	});

	test("surfaces a JSON-RPC error carried over SSE", async () => {
		const envelope = await readSiteBuilderRpcEnvelope(
			sse(
				'data: {"jsonrpc":"2.0","id":"e","error":{"code":-32601,"message":"Method not found"}}\n',
			),
			"e",
		);
		expect(envelope.result).toBeUndefined();
		expect(envelope.error?.message).toBe("Method not found");
	});

	test("still reads the plain-JSON negotiation outcome", async () => {
		const envelope = await readSiteBuilderRpcEnvelope(
			jsonResponse({ jsonrpc: "2.0", id: "j", result: { tools: [] } }),
			"j",
		);
		expect(envelope.result).toEqual({ tools: [] });
	});

	test("an SSE body with no response frame fails closed", async () => {
		const envelope = await readSiteBuilderRpcEnvelope(
			sse('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n'),
			"req-1",
		);
		expect(envelope.result).toBeUndefined();
		expect(envelope.error?.message).toContain("no JSON-RPC response frame");
	});

	test("a non-MCP content type fails closed instead of parsing garbage", async () => {
		const envelope = await readSiteBuilderRpcEnvelope(
			new Response("<html>gateway error</html>", {
				headers: { "content-type": "text/html" },
				status: 502,
			}),
		);
		expect(envelope.result).toBeUndefined();
		expect(envelope.error?.message).toContain("text/html");
	});
});
