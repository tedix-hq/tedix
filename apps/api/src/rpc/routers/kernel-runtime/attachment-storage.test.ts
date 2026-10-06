import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
	resolveHomeAttachments,
	storeHomeAttachment,
	validateHomeAttachment,
} from "./attachment-storage";
import {
	homeAttachmentContent,
	homeModelPrompt,
} from "../kernel/attachment-content";

function textFile(text = "The secret word is cobalt.") {
	return {
		type: "file" as const,
		fileName: "notes.txt",
		mimeType: "text/plain",
		content: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
	};
}
function bucketFixture() {
	const objects = new Map<string, string>();
	return {
		objects,
		bucket: {
			put: async (key: string, body: string) => {
				objects.set(key, body);
			},
			get: async (key: string) => {
				const body = objects.get(key);
				return body
					? { size: body.length, json: async () => JSON.parse(body) }
					: null;
			},
		} as unknown as R2Bucket,
	};
}
describe("private chat attachments", () => {
	it("keeps bytes outside the chat frame and resolves canonical content within the tenant", async () => {
		const { bucket, objects } = bucketFixture();
		const original = textFile("screenshot-sized text ".repeat(20000));
		const handle = await storeHomeAttachment(bucket, "org-a", original);
		expect(JSON.stringify(handle).length).toBeLessThan(1024);
		expect(handle.content).toMatch(/^tedix-attachment:[a-f0-9]{64}$/);
		expect(await storeHomeAttachment(bucket, "org-a", original)).toEqual(
			handle,
		);
		expect(objects.size).toBe(1);
		const resolved = await resolveHomeAttachments(bucket, "org-a", [
			{ ...handle, fileName: "forged.pdf", size: 0 },
		]);
		expect(resolved?.[0]).toEqual(validateHomeAttachment(original));
		await expect(
			resolveHomeAttachments(bucket, "org-b", [handle]),
		).rejects.toThrow("not found");
	});
	it("delivers file contents, not filenames, as untrusted source text", () => {
		const { text, images } = homeAttachmentContent("What is the word?", [
			validateHomeAttachment(textFile()),
		]);
		expect(text).toContain("The secret word is cobalt.");
		expect(text).toContain("untrusted source");
		expect(images).toEqual([]);
		expect(homeModelPrompt(text)).toEqual({ prompt: text });
	});
	it("delivers image bytes as native image file parts", () => {
		const content =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4S8AAAAASUVORK5CYII=";
		const image = validateHomeAttachment({
			type: "image",
			fileName: "pixel.png",
			mimeType: "image/png",
			content,
		});
		const prompt = homeAttachmentContent("Read the screenshot", [image]);
		expect(homeModelPrompt(prompt.text, prompt.images)).toEqual({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Read the screenshot" },
						{ type: "file", mediaType: "image", data: content },
					],
				},
			],
		});
	});
	it("rejects unsupported binary formats, mismatched images, malformed base64 and invalid UTF-8", () => {
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				mimeType: "application/pdf",
				content: "data:application/pdf;base64,JVBERg==",
			}),
		).toThrow("not supported");
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				type: "image",
				mimeType: "image/png",
				content: "data:image/png;base64,dGV4dA==",
			}),
		).toThrow("valid PNG");
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				content: "data:text/plain;base64,%%%",
			}),
		).toThrow("base64");
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				content: "data:text/plain;base64,/w==",
			}),
		).toThrow("UTF-8");
	});
	it("bounds actual bytes regardless of client size and rejects external URLs", async () => {
		const { bucket } = bucketFixture();
		await expect(
			resolveHomeAttachments(
				bucket,
				"org-a",
				Array.from({ length: 6 }, () => textFile()),
			),
		).rejects.toThrow("five");
		await expect(
			resolveHomeAttachments(bucket, "org-a", [
				textFile("a".repeat(600000)),
				textFile("b".repeat(600000)),
			]),
		).rejects.toThrow("total");
		expect(() =>
			validateHomeAttachment(textFile("a".repeat(1048577))),
		).toThrow();
		await expect(
			resolveHomeAttachments(bucket, "org-a", [
				{ ...textFile(), content: "https://example.com/file.txt" },
			]),
		).rejects.toThrow("base64");
	});
});
