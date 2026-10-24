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
});
