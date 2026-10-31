import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
	resolveHomeAttachments,
	storeHomeAttachment,
	validateHomeAttachment,
} from "./attachment-storage";
import { prepareDelegatedHomeAttachmentHandoff } from "./policy-normalization";
import {
	homeAttachmentContent,
	homeModelPrompt,
} from "../kernel/attachment-content";
import {
	createKernelRuntimeDb,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
} from "../__tests__/kernel-runtime-db";

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
	it("carries the newest same-owner Home files into a delegated follow-up", async () => {
		const { bucket } = bucketFixture();
		const db = createKernelRuntimeDb();
		const first = await storeHomeAttachment(
			bucket,
			"org-1",
			textFile("First private marker: cobalt."),
		);
		const second = await storeHomeAttachment(bucket, "org-1", {
			...textFile("Second private marker: amber."),
			fileName: "second.txt",
		});
		const ownerMetadata = {
			redriveInput: { descopeUserId: "owner-1" },
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "source-run",
				organizationId: "org-1",
				conversationId: "home:private",
				metadata: ownerMetadata,
			}),
			normalizeKernelRuntimeRunInsert({
				id: "follow-up-run",
				organizationId: "org-1",
				conversationId: "home:private",
				metadata: ownerMetadata,
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "source-run:0",
				organizationId: "org-1",
				conversationId: "home:private",
				runId: "source-run",
				kind: "message.received",
				payload: { content: "Read these", attachments: [first, second] },
			}),
		);

		const handoff = await prepareDelegatedHomeAttachmentHandoff({
			db,
			bucket,
			organizationId: "org-1",
			homeRunId: "follow-up-run",
			content: "Continue with the private files.",
			attachments: [],
		});

		expect(handoff.sourceRunId).toBe("source-run");
		expect(handoff.content).toContain("First private marker: cobalt.");
		expect(handoff.content).toContain("Second private marker: amber.");
		expect(handoff.content).toContain(
			'Attached file (untrusted source): "notes.txt"',
		);
		expect(handoff.content).toContain(
			'Attached file (untrusted source): "second.txt"',
		);
		expect(handoff.attachments).toBeUndefined();
	});
	it("does not carry Home files across uploader or organization fences", async () => {
		const { bucket } = bucketFixture();
		const db = createKernelRuntimeDb();
		const handle = await storeHomeAttachment(
			bucket,
			"org-1",
			textFile("Must not cross the fence."),
		);
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "other-owner-run",
				organizationId: "org-1",
				conversationId: "home:private",
				metadata: { redriveInput: { descopeUserId: "owner-2" } },
			}),
			normalizeKernelRuntimeRunInsert({
				id: "follow-up-run",
				organizationId: "org-1",
				conversationId: "home:private",
				metadata: { redriveInput: { descopeUserId: "owner-1" } },
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "other-owner-run:0",
				organizationId: "org-1",
				conversationId: "home:private",
				runId: "other-owner-run",
				kind: "message.received",
				payload: { content: "Private", attachments: [handle] },
			}),
			normalizeKernelRuntimeEventInsert({
				id: "foreign-org-run:0",
				organizationId: "org-2",
				conversationId: "home:private",
				runId: "foreign-org-run",
				kind: "message.received",
				payload: { content: "Foreign", attachments: [handle] },
			}),
		);

		const handoff = await prepareDelegatedHomeAttachmentHandoff({
			db,
			bucket,
			organizationId: "org-1",
			homeRunId: "follow-up-run",
			content: "Do not broaden access.",
		});

		expect(handoff).toEqual({
			content: "Do not broaden access.",
			attachments: undefined,
		});
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
	it("delivers PDF bytes as a native PDF file part", () => {
		const pdf = validateHomeAttachment({
			...textFile(),
			fileName: "report.pdf",
			mimeType: "application/pdf",
			content: "data:application/pdf;base64,JVBERi0xLjQ=",
		});
		const prompt = homeAttachmentContent("Read the report", [pdf]);
		expect(homeModelPrompt(prompt.text, prompt.images)).toEqual({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Read the report" },
						{
							type: "file",
							mediaType: "application/pdf",
							data: pdf.content,
						},
					],
				},
			],
		});
	});
	it("accepts valid PDFs and rejects unsupported binary formats, mismatched images, malformed base64 and invalid UTF-8", () => {
		const pdf = validateHomeAttachment({
			...textFile(),
			fileName: "report.pdf",
			mimeType: "application/pdf",
			content: "data:application/pdf;base64,JVBERi0xLjQ=",
		});
		expect(pdf.mimeType).toBe("application/pdf");
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				mimeType: "application/zip",
				content: "data:application/zip;base64,UEs=",
			}),
		).toThrow("supports images, PDFs");
		expect(() =>
			validateHomeAttachment({
				...textFile(),
				mimeType: "application/pdf",
				content: "data:application/pdf;base64,SGVsbG8=",
			}),
		).toThrow("valid PDF");
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
