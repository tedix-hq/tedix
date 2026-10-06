import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import { hydrateHomeHistory } from "./attachment-content";
import { validateHomeAttachment } from "../kernel-runtime/attachment-storage";

const file: TediMessageAttachment = {
	type: "file",
	fileName: "notes.txt",
	mimeType: "text/plain",
	content: `data:text/plain;base64,${Buffer.from("The secret word is cobalt.").toString("base64")}`,
};

describe("bounded history attachment hydration", () => {
	it("rehydrates text contents and leaves persisted handles untouched", async () => {
		const handle = { ...file, content: "tedix-attachment:reference" };
		const history = [
			{ role: "user" as const, content: "read this", attachments: [handle] },
		];
		const replay = await hydrateHomeHistory(history, async () => [
			validateHomeAttachment(file),
		]);
		expect(replay[0]?.content).toContain("The secret word is cobalt.");
		expect(replay[0]?.content).toContain("untrusted source");
		expect(history[0]?.attachments[0]?.content).toBe(
			"tedix-attachment:reference",
		);
		expect(replay[0]?.attachments).toBeUndefined();
	});

	it("loads at most five newest files while preserving original message order", async () => {
		const history = Array.from({ length: 8 }, (_, index) => ({
			role: "user" as const,
			content: `turn ${index}`,
			attachments: [{ ...file, fileName: `${index}.txt` }],
		}));
		const resolve = vi.fn(
			async (attachments: readonly TediMessageAttachment[]) =>
				attachments.map(validateHomeAttachment),
		);
		const replay = await hydrateHomeHistory(history, resolve);
		expect(resolve).toHaveBeenCalledTimes(5);
		expect(
			resolve.mock.calls.map(([attachments]) => attachments[0]?.fileName),
		).toEqual(["7.txt", "6.txt", "5.txt", "4.txt", "3.txt"]);
		expect(replay.map((message) => message.content.split("\n")[0])).toEqual(
			history.map((message) => message.content),
		);
		expect(replay[0]?.content).toContain("history replay limit reached");
	});

	it("reports missing and unsupported attachments without removing the user turn", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const replay = await hydrateHomeHistory(
				[
					{
						role: "user",
						content: "",
						attachments: [file, { ...file, type: "audio" }],
					},
				],
				async () => {
					throw new Error("not found");
				},
			);
			expect(replay[0]?.content).toContain(
				"stored content is unavailable or invalid",
			);
			expect(replay[0]?.content).toContain("audio replay is not supported");
			expect(replay[0]?.attachments).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});

	it("bounds expanded file text with an explicit truncation notice", async () => {
		const large = validateHomeAttachment({
			...file,
			content: `data:text/plain;base64,${Buffer.from("x".repeat(100_000)).toString("base64")}`,
		});
		const replay = await hydrateHomeHistory(
			[{ role: "user", content: "", attachments: [large, large] }],
			async () => [large],
		);
		expect(replay[0]?.content.length).toBeLessThan(17_000);
		expect(replay[0]?.content).toContain("Attachment text truncated");
	});
});
