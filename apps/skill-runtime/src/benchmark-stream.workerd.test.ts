import { describe, expect, it } from "vite-plus/test";
import { readBenchmarkTurnStream } from "./benchmark-stream";

function streamOf(chunks: Uint8Array[]) {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			// Terminal frames must complete even when the upstream stays open.
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, cancelled: () => cancelled };
}

describe("benchmark turn stream", () => {
	const maxLineBytes = 1024 * 1024;
	const doneFrame = 'data: {"kind":"done","text":"reply","runId":"run-1"}\n';
	for (const chunks of [
		["x".repeat(maxLineBytes + 1), `\n${doneFrame}`],
		["x".repeat(maxLineBytes), "x", `\n${doneFrame}`],
		[`${"x".repeat(maxLineBytes + 1)}\n${doneFrame}`],
		["ü".repeat(maxLineBytes / 2), "ü", `\n${doneFrame}`],
	]) {
		it(`rejects oversized lines across ${chunks.length} chunks and cancels`, async () => {
			const input = streamOf(
				chunks.map((chunk) => new TextEncoder().encode(chunk)),
			);
			expect(await readBenchmarkTurnStream(input.stream)).toEqual({
				assistant: "",
				runId: null,
				errMsg: "Benchmark SSE line exceeds 1048576 bytes",
			});
			expect(input.cancelled()).toBe(true);
		});
	}

	it("accepts lines at the byte limit and resets the bound after each newline", async () => {
		const line = ":" + "x".repeat(maxLineBytes - 1);
		const input = streamOf([
			new TextEncoder().encode(`${line}\n${line}\n${doneFrame}`),
		]);
		expect(await readBenchmarkTurnStream(input.stream)).toEqual({
			assistant: "reply",
			runId: "run-1",
			errMsg: null,
		});
		expect(input.cancelled()).toBe(true);
	});

	for (const prefix of ["\n", ": keepalive\n", "event: message\n", "\r\n"]) {
		it(`advances past ${JSON.stringify(prefix)}`, async () => {
			const input = streamOf([
				new TextEncoder().encode(
					`${prefix}data: {"kind":"progress"}\n\ndata: {"kind":"done","text":"reply","runId":"run-1"}\n\n`,
				),
			]);
			expect(await readBenchmarkTurnStream(input.stream)).toEqual({
				assistant: "reply",
				runId: "run-1",
				errMsg: null,
			});
			expect(input.cancelled()).toBe(true);
		});
	}

	it("retains split lines and UTF-8 characters across chunks", async () => {
		const bytes = new TextEncoder().encode(
			': keepalive\r\ndata: invalid JSON\r\n\r\ndata: {"kind":"done","text":"Grüße 👋","sessionKey":"session-1"}\r\n\r\n',
		);
		const input = streamOf(Array.from(bytes, (byte) => Uint8Array.of(byte)));
		expect(await readBenchmarkTurnStream(input.stream)).toEqual({
			assistant: "Grüße 👋",
			runId: "session-1",
			errMsg: null,
		});
		expect(input.cancelled()).toBe(true);
	});

	it("returns terminal errors after non-data lines and cancels the reader", async () => {
		const input = streamOf([
			new TextEncoder().encode(
				'event: message\n\ndata: {"kind":"error","message":"upstream failed"}\n\n',
			),
		]);
		expect(await readBenchmarkTurnStream(input.stream)).toEqual({
			assistant: "",
			runId: null,
			errMsg: "upstream failed",
		});
		expect(input.cancelled()).toBe(true);
	});

	for (const [label, body, expected] of [
		[
			"fails a stream that closes before a terminal frame",
			'data: {"kind":"progress"}\n',
			{
				assistant: "",
				runId: null,
				errMsg: "Benchmark stream closed before a done or error frame",
			},
		],
		[
			"accepts a done frame without a trailing newline at close",
			'data: {"kind":"done","text":"reply","runId":"run-1"}',
			{ assistant: "reply", runId: "run-1", errMsg: null },
		],
	] as const) {
		it(label, async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			});
			expect(await readBenchmarkTurnStream(stream)).toEqual(expected);
		});
	}
});
