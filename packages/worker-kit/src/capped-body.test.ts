import { describe, expect, it } from "vite-plus/test";
import { readTextCapped } from "./capped-body";

function streamed(chunks: string[], onPull?: () => void): Request {
	const encoder = new TextEncoder();
	let index = 0;
	return new Request("https://example.test/hook", {
		method: "POST",
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				onPull?.();
				const chunk = chunks[index++];
				if (chunk === undefined) controller.close();
				else controller.enqueue(encoder.encode(chunk));
			},
		}),
		// @ts-expect-error duplex is required for a streamed body outside browsers
		duplex: "half",
	});
}

describe("readTextCapped", () => {
	it("returns a body within the limit", async () => {
		expect(await readTextCapped(streamed(["hello ", "wörld"]), 64)).toBe(
			"hello wörld",
		);
	});

	it("refuses a declared oversized body without reading it", async () => {
		const request = new Request("https://example.test/hook", {
			method: "POST",
			headers: { "content-length": "999999" },
			body: "x",
		});
		expect(await readTextCapped(request, 10)).toBeNull();
		expect(request.bodyUsed).toBe(false);
	});

	it("stops reading an undeclared body once it passes the limit", async () => {
		let pulls = 0;
		const chunks = Array.from({ length: 1000 }, () => "x".repeat(100));
		expect(
			await readTextCapped(
				streamed(chunks, () => pulls++),
				250,
			),
		).toBeNull();
		expect(pulls).toBeLessThan(10);
	});

	it("counts bytes, not characters", async () => {
		expect(await readTextCapped(streamed(["ééé"]), 5)).toBeNull();
		expect(await readTextCapped(streamed(["ééé"]), 6)).toBe("ééé");
	});
});
