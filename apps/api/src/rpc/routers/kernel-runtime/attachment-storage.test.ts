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

describe("workspace files linked from Home", () => {
	const workspaceId = "0c2464ac-201c-4e56-bb40-e1499d4673fe";
	const imageId = "3fa7445c-e04e-4324-a651-6baff0d40c96";
	const notesId = "9b1c2d3e-4f50-4a61-8b72-c3d4e5f60718";
	const pixel = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4S8AAAAASUVORK5CYII=",
		"base64",
	);
	function fileSource(
		files: Record<string, { name: string; mimeType: string; bytes: Buffer }>,
	) {
		const objects = new Map<string, Buffer | string>();
		for (const [id, file] of Object.entries(files)) {
			const key = `workspace-files/org-1/${workspaceId}/${id}`;
			objects.set(key, file.bytes);
			objects.set(
				`${key}.json`,
				JSON.stringify({
					filename: file.name,
					mimeType: file.mimeType,
					size: file.bytes.length,
					organizationId: "org-1",
					workspaceId,
					resourceId: id,
					uploadId: "upload",
					createdByKind: "user",
					createdById: "owner-1",
					createdAt: "2026-11-04T20:53:33.000Z",
					expiresAt: "2026-11-04T21:08:33.000Z",
					mimeValidated: true,
				}),
			);
		}
		return {
			bucket: {
				get: async (key: string) => {
					const body = objects.get(key);
					if (body === undefined) return null;
					return {
						json: async () => JSON.parse(String(body)),
						arrayBuffer: async () =>
							typeof body === "string" ? Buffer.from(body) : body,
					};
				},
			} as unknown as R2Bucket,
			getResource: async (params: {
				organizationId: string;
				workspaceId: string;
				resourceId: string;
			}) => {
				const file = files[params.resourceId];
				return file &&
					params.organizationId === "org-1" &&
					params.workspaceId === workspaceId
					? ({
							id: params.resourceId,
							name: file.name,
							status: "active",
							providerId: "tedix",
							resourceType: "file",
						} as never)
					: undefined;
			},
		};
	}
	function homeRun(
		db: ReturnType<typeof createKernelRuntimeDb>,
		workspace: string | null,
	) {
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run",
				organizationId: "org-1",
				conversationId: "home:os:fix-app",
				runtimeMetadata: workspace
					? {
							workspaceContext: {
								workspaceId: workspace,
								workspaceName: "Reddit",
							},
						}
					: {},
			}),
		);
	}
	const content = [
		`Workspace file: Screenshot.png (https://acme.os.tedix.dev/outputs/${imageId})`,
		`Workspace file: notes.txt (https://acme.os.tedix.dev/outputs/${notesId})`,
		"",
		"fix the loading ui for the research explained gadget app.",
	].join("\n");

	it("hands the delegated tedi the screenshot as an image and the text inline", async () => {
		const db = createKernelRuntimeDb();
		homeRun(db, workspaceId);
		const handoff = await prepareDelegatedHomeAttachmentHandoff({
			db,
			bucket: bucketFixture().bucket,
			organizationId: "org-1",
			homeRunId: "home-run",
			content,
			workspaceFiles: fileSource({
				[imageId]: {
					name: "Screenshot.png",
					mimeType: "image/png",
					bytes: pixel,
				},
				[notesId]: {
					name: "notes.txt",
					mimeType: "text/plain",
					bytes: Buffer.from("Spinner never stops."),
				},
			}),
		});
		expect(handoff.attachments).toEqual([
			expect.objectContaining({
				type: "image",
				fileName: "Screenshot.png",
				mimeType: "image/png",
				content: `data:image/png;base64,${pixel.toString("base64")}`,
			}),
		]);
		expect(handoff.content).toContain(
			'Attached file (untrusted source): "notes.txt"\nSpinner never stops.',
		);
	});

	it("leaves links alone outside the Home run's workspace and names files it cannot attach", async () => {
		const files = {
			[imageId]: {
				name: "Screenshot.png",
				mimeType: "image/png",
				bytes: Buffer.alloc(1024 * 1024 + 1, 1),
			},
		};
		const outside = createKernelRuntimeDb();
		homeRun(outside, null);
		expect(
			await prepareDelegatedHomeAttachmentHandoff({
				db: outside,
				bucket: bucketFixture().bucket,
				organizationId: "org-1",
				homeRunId: "home-run",
				content,
				workspaceFiles: fileSource(files),
			}),
		).toEqual({ content, attachments: undefined });

		const inside = createKernelRuntimeDb();
		homeRun(inside, workspaceId);
		const handoff = await prepareDelegatedHomeAttachmentHandoff({
			db: inside,
			bucket: bucketFixture().bucket,
			organizationId: "org-1",
			homeRunId: "home-run",
			content,
			workspaceFiles: fileSource(files),
		});
		expect(handoff.attachments).toBeUndefined();
		expect(handoff.content).toContain(
			'[Workspace file "Screenshot.png" not attached: larger than 1 MiB.]',
		);
	});
});
