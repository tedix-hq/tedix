import { describe, expect, it, vi } from "vite-plus/test";
import { autoRouterSdkStream } from "./auto-router-stream";
const encode = (value: unknown) =>
	new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);
const receipt = {
	cloudflareAutoRouter: { routedModel: "model", requestId: "request" },
};
const final = {
	choices: [{ delta: {}, finish_reason: "stop" }],
	usage: {
		prompt_tokens: 10,
		completion_tokens: 2,
		prompt_tokens_details: { cached_tokens: 3 },
		completion_tokens_details: { reasoning_tokens: 1 },
	},
};
async function collect(body: ReadableStream<Uint8Array>) {
	const output = [];
	for await (const part of autoRouterSdkStream(body, receipt))
		output.push(part);
	return output;
}
function body(frames: unknown[]) {
	return new ReadableStream<Uint8Array>({
		start(c) {
			for (const f of frames) c.enqueue(encode(f));
			c.close();
		},
	});
}

describe("incremental Auto Router stream", () => {
	it("delivers text while the provider completion is still blocked", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const reader = autoRouterSdkStream(upstream, receipt).getReader();
		expect((await reader.read()).value).toMatchObject({ type: "stream-start" });
		controller.enqueue(encode({ choices: [{ delta: { content: "Early" } }] }));
		expect((await reader.read()).value).toMatchObject({ type: "text-start" });
		expect((await reader.read()).value).toEqual({
			type: "text-delta",
			id: "txt-0",
			delta: "Early",
		});
		// Only now release the remaining provider output and receipt.
		controller.enqueue(encode({ choices: [{ delta: { content: " later" } }] }));
		controller.enqueue(encode(final));
		controller.close();
		const rest = [];
		while (true) {
			const r = await reader.read();
			if (r.done) break;
			rest.push(r.value);
		}
		expect(rest.filter((p) => p.type === "finish")).toEqual([
			{
				type: "finish",
				finishReason: "stop",
				usage: {
					inputTokens: 10,
					outputTokens: 2,
					totalTokens: 12,
					cachedInputTokens: 3,
					reasoningTokens: 1,
				},
				providerMetadata: receipt,
			},
		]);
	});
	it("decodes split UTF8 and interleaved tool names/arguments with a trailing usage-only frame", async () => {
		const bytes = new Uint8Array([
			...encode({
				choices: [
					{
						delta: {
							reasoning_content: "Sí",
							tool_calls: [
								{ index: 0, id: "a", function: { name: "look" } },
								{
									index: 1,
									id: "b",
									function: { name: "other", arguments: '{"n":' },
								},
							],
						},
					},
				],
			}),
			...encode({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { name: "up", arguments: '{"id":' } },
								{ index: 1, function: { arguments: "2}" } },
							],
						},
					},
				],
			}),
			...encode({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: "1}" } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			...encode({
				choices: [],
				usage: { prompt_tokens: 12, completion_tokens: 5 },
			}),
		]);
		const parts = await collect(
			new ReadableStream({
				start(c) {
					for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
					c.close();
				},
			}),
		);
		expect(parts).toContainEqual({
			type: "reasoning-delta",
			id: "reasoning-0",
			delta: "Sí",
		});
		expect(parts.filter((p) => p.type === "tool-call")).toEqual([
			{
				type: "tool-call",
				toolCallId: "a",
				toolName: "lookup",
				input: '{"id":1}',
			},
			{
				type: "tool-call",
				toolCallId: "b",
				toolName: "other",
				input: '{"n":2}',
			},
		]);
		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: "tool-calls",
			usage: { inputTokens: 12, outputTokens: 5 },
			providerMetadata: receipt,
		});
	});
	it.each([
		[{ choices: [{ delta: { content: "partial" } }] }],
		[{ choices: [{ finish_reason: "stop", delta: {} }] }],
		[{ error: { message: "failure" } }],
	])("rejects missing completion, usage and provider errors", async (frame) => {
		await expect(collect(body([frame]))).rejects.toThrow();
	});
	it("rejects malformed JSON", async () => {
		await expect(
			collect(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: {bad}\n\n"));
						c.close();
					},
				}),
			),
		).rejects.toThrow();
	});
	it("cancels upstream when the consumer cancels", async () => {
		const cancel = vi.fn();
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encode({ choices: [{ delta: { content: "partial" } }] }));
			},
			cancel,
		});
		const reader = autoRouterSdkStream(upstream, receipt).getReader();
		await reader.read();
		await reader.read();
		await reader.read();
		await reader.cancel("operator canceled");
		await vi.waitFor(() =>
			expect(cancel).toHaveBeenCalledWith("operator canceled"),
		);
	});
	it.each([
		["length", "length"],
		["content_filter", "content-filter"],
	])("preserves %s finish reason", async (wire, expected) => {
		const parts = await collect(
			body([
				{
					...final,
					choices: [{ delta: { content: "answer" }, finish_reason: wire }],
				},
			]),
		);
		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: expected,
		});
	});
});
