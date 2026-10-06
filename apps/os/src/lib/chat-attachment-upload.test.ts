import { describe, expect, it, vi } from "vite-plus/test";
import {
	prepareChatAttachment,
	uploadChatAttachments,
} from "./chat-attachment-upload";

describe("chat attachment upload", () => {
	it("uploads large bytes via HTTP and sends only immutable handles", async () => {
		const attachment = {
			type: "image" as const,
			fileName: "screenshot.png",
			mimeType: "image/png",
			size: 400000,
			content: `data:image/png;base64,${"A".repeat(533336)}`,
		};
		const handle = {
			...attachment,
			content: `tedix-attachment:${"a".repeat(64)}`,
		};
		const upload = vi.fn(async () => handle);
		const sent = await uploadChatAttachments([attachment], upload);
		expect(upload).toHaveBeenCalledWith(attachment);
		expect(JSON.stringify(sent).length).toBeLessThan(1024);
		expect(await uploadChatAttachments(sent, upload)).toEqual(sent);
		expect(upload).toHaveBeenCalledTimes(1);
	});
	it("propagates upload failure before anything can be sent", async () => {
		await expect(
			uploadChatAttachments(
				[
					{
						type: "file",
						fileName: "a.txt",
						mimeType: "text/plain",
						content: "data:text/plain;base64,YQ==",
						size: 1,
					},
				],
				async () => {
					throw new Error("Upload failed");
				},
			),
		).rejects.toThrow("Upload failed");
	});
	it("preserves UTF-8 text files and rejects unsupported formats and oversized files", async () => {
		const file = new File(["actual contents"], "notes.md");
		expect(await prepareChatAttachment(file)).toEqual({
			blob: file,
			mimeType: "text/plain",
		});
		await expect(
			prepareChatAttachment(
				new File(["%PDF"], "a.pdf", { type: "application/pdf" }),
			),
		).rejects.toThrow("not supported");
		await expect(
			prepareChatAttachment(
				new File([new Uint8Array(1048577)], "a.txt", { type: "text/plain" }),
			),
		).rejects.toThrow("1 MiB");
	});
});
