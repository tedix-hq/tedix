import { describe, expect, it } from "vite-plus/test";
import {
	consumeRuntimeFrames,
	readChatRuntimePhase,
	type RuntimeFrame,
} from "./runtime-frames";

describe("runtime phase frames", () => {
	it("accepts the shared phase vocabulary and trims detail", () => {
		expect(
			readChatRuntimePhase({
				kind: "phase",
				phase: "using_tool",
				detail: "  search_orders  ",
			}),
		).toEqual({
			kind: "phase",
			phase: "using_tool",
			detail: "search_orders",
		});
		expect(
			readChatRuntimePhase({ kind: "phase", phase: "invented" }),
		).toBeNull();
	});
});

describe("runtime framing across Capn subscription reattachment", () => {
	it("discards partial bytes at response boundaries and commits only complete frame ids", async () => {
		const frames: RuntimeFrame[] = [];
		const deliver = async (frame: RuntimeFrame) => {
			frames.push(frame);
		};
		await consumeRuntimeFrames(
			new Response(
				'id: test-run:1\ndata: {"kind":"delta","text":"A"}\n\nid: test-run:2\ndata: {"kind":"del',
			),
			deliver,
		);
		expect(frames.map((f) => f.id)).toEqual(["test-run:1"]);
		await consumeRuntimeFrames(
			new Response(
				'id: test-run:2\ndata: {"kind":"delta","text":"B"}\n\nid: test-run:3\ndata: {"kind":"done","text":"AB"}\n\n',
			),
			deliver,
		);
		expect(
			frames
				.filter((f) => f.event.kind === "delta")
				.map((f) => f.event.text)
				.join(""),
		).toBe("AB");
		expect(frames.map((f) => f.id)).toEqual([
			"test-run:1",
			"test-run:2",
			"test-run:3",
		]);
	});
	it("handles arbitrary UTF-8 byte boundaries and CRLF framing", async () => {
		const bytes = new TextEncoder().encode(
			'id: run:1\r\ndata: {"kind":"delta","text":"Órdenes"}\r\n\r\n',
		);
		const response = new Response(
			new ReadableStream({
				start(controller) {
					for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
					controller.close();
				},
			}),
		);
		const frames: RuntimeFrame[] = [];
		await consumeRuntimeFrames(response, async (frame) => {
			frames.push(frame);
		});
		expect(frames).toEqual([
			{ id: "run:1", event: { kind: "delta", text: "Órdenes" } },
		]);
	});
});
