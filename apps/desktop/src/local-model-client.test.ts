import { expect, test } from "bun:test";
import { listLocalModels, streamLocalModelReply } from "./local-model-client";

test("discovers Ollama models on loopback and excludes cloud entries", async () => {
	const ids = await listLocalModels(
		{ provider: "ollama", port: 11438 },
		async (url, init) => {
			expect(url).toBe("http://127.0.0.1:11438/api/tags");
			expect(init?.redirect).toBe("error");
			return Response.json({
				models: [
					{ name: "smollm2:135m" },
					{ name: "gpt-oss:120b-cloud" },
					{ name: "remote-alias", remote_host: "https://ollama.com" },
				],
			});
		},
	);
	expect(ids).toEqual(["smollm2:135m"]);
});

test("discovers LM Studio models through the OpenAI-compatible endpoint", async () => {
	const ids = await listLocalModels(
		{ provider: "lmstudio", port: 1234 },
		async (url) => {
			expect(url).toBe("http://127.0.0.1:1234/v1/models");
			return Response.json({
				data: [{ id: "local-chat-model" }, { id: "local-chat-model" }],
			});
		},
	);
	expect(ids).toEqual(["local-chat-model"]);
});

test("delivers text incrementally, even with a split UTF-8 character and SSE boundary", async () => {
	const encoder = new TextEncoder();
	const first = encoder.encode(
		'data: {"choices":[{"delta":{"content":"Hello 🌱"}}]}\r\n\r\n',
	);
	const split = first.indexOf(0xf0) + 1;
	let push!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			push = controller;
		},
	});
	const seen: string[] = [];
	const reply = streamLocalModelReply(
		{
			provider: "lmstudio",
			port: 1234,
			model: "local-chat-model",
			messages: [{ role: "user", content: "Hello" }],
		},
		(text) => seen.push(text),
		new AbortController().signal,
		async (url, init) => {
			expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
			expect(init?.redirect).toBe("error");
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "local-chat-model",
				stream: true,
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	);
	push.enqueue(first.slice(0, split));
	push.enqueue(first.slice(split, -1));
	push.enqueue(first.slice(-1));
	await Bun.sleep(0);
	expect(seen).toEqual(["Hello 🌱"]);
	push.enqueue(
		encoder.encode(
			'data: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n',
		),
	);
	expect(await reply).toBe("Hello 🌱 there");
});

test("reports a dropped stream without silently dispatching another request", async () => {
	let requests = 0;
	const reply = streamLocalModelReply(
		{
			provider: "ollama",
			port: 11434,
			model: "smollm2:135m",
			messages: [{ role: "user", content: "Hello" }],
		},
		() => {},
		new AbortController().signal,
		async () => {
			requests++;
			return new Response(
				'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
				{
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		},
	);
	await expect(reply).rejects.toThrow("closed before the reply finished");
	expect(requests).toBe(1);
});
