import assert from "node:assert/strict";
import {
	type AudioAttachment,
	MAX_INLINE_IMAGE_BYTES,
	MAX_TURN_IMAGES,
	resolveTurnImageParts,
	resolveVoiceMessageContent,
	type VoiceSttEnv,
} from "./stt";

/** A base64 string that decodes to roughly `bytes` bytes ("A"=0x00 byte each
 * pair of base64 chars ≈ ...). 4 base64 chars encode 3 bytes, so we size by
 * the 4/3 ratio and round up. */
function base64OfSize(bytes: number): string {
	const chars = Math.ceil((bytes * 4) / 3 / 4) * 4;
	return "A".repeat(chars);
}

function imageAttachment(
	overrides: Partial<AudioAttachment> = {},
): AudioAttachment {
	return {
		type: "image",
		content: "iVBORw0KGgo=", // tiny valid base64
		fileName: "shot.png",
		mimeType: "image/png",
		...overrides,
	};
}

const env = {} as VoiceSttEnv;

function audio(overrides: Partial<AudioAttachment> = {}): AudioAttachment {
	return {
		type: "audio",
		content: "AAAA",
		fileName: "note.webm",
		mimeType: "audio/webm",
		...overrides,
	};
}

async function test(
	name: string,
	fn: () => Promise<void> | void,
): Promise<void> {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.error(`  ✗ ${name}`);
		console.error(error);
		throw error;
	}
}

await test("transcribes the first audio attachment into model-facing content", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "please capture this",
		attachments: [audio()],
		transcribe: async () => ({
			text: "call Ada tomorrow",
			provider: "workers-ai",
		}),
	});

	assert.equal(
		resolved.content,
		"please capture this\n\n[Voice message transcript]\ncall Ada tomorrow",
	);
	assert.deepEqual(resolved.voiceTranscript, {
		transcript: "call Ada tomorrow",
		provider: "workers-ai",
		fileName: "note.webm",
		mimeType: "audio/webm",
	});
});

await test("fails soft when transcription throws", async () => {
	const warnings: Array<[string, string]> = [];
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "",
		attachments: [audio()],
		logContext: "test.voice",
		transcribe: async () => {
			throw new Error("provider unavailable");
		},
		warn: (message, reason) => warnings.push([message, reason]),
	});

	assert.equal(
		resolved.content,
		"[audio transcription failed: provider unavailable]",
	);
	assert.equal(resolved.voiceTranscript, null);
	assert.deepEqual(warnings, [
		["[test.voice] voice-note transcription failed:", "provider unavailable"],
	]);
});

await test("optionally appends non-audio attachment notes for isolate turns", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "see attached",
		attachments: [
			audio(),
			{
				type: "file",
				content: "Zm9v",
				fileName: "brief.pdf",
				mimeType: "application/pdf",
			},
		],
		includeNonAudioAttachmentNote: true,
		transcribe: async () => ({ text: "voice context", provider: "azure" }),
	});

	assert.equal(
		resolved.content,
		[
			"see attached",
			"",
			"[Voice message transcript]",
			"voice context",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- brief.pdf (application/pdf)]",
		].join("\n"),
	);
});

// ── FAIL-SOFT multimodal image resolution ───────────────────────────────────

await test("resolves an image attachment into a base64 image content part", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "what is in this image?",
		attachments: [imageAttachment()],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	// The image becomes a model image part...
	assert.equal(resolved.images.length, 1);
	assert.deepEqual(resolved.images[0], {
		kind: "base64",
		data: "iVBORw0KGgo=",
		mediaType: "image/png",
		fileName: "shot.png",
	});
	// ...and is DROPPED from the note (it reaches the model directly), so the
	// content is the user text unchanged with no attachment note appended.
	assert.equal(resolved.content, "what is in this image?");
});

await test("references an already-stored (URL) image instead of inlining", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "describe",
		attachments: [
			imageAttachment({
				content: "https://r2.example/objects/abc.png",
				mimeType: "image/png",
			}),
		],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	assert.equal(resolved.images.length, 1);
	assert.equal(resolved.images[0]!.kind, "url");
	assert.equal(resolved.images[0]!.data, "https://r2.example/objects/abc.png");
	assert.equal(resolved.content, "describe");
});

await test("FAIL-SOFT: oversized image falls back to the filename note", async () => {
	const big = base64OfSize(MAX_INLINE_IMAGE_BYTES + 1024);
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "look",
		attachments: [imageAttachment({ content: big, fileName: "huge.png" })],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	assert.equal(resolved.images.length, 0, "no image part for oversized image");
	assert.equal(
		resolved.content,
		[
			"look",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- huge.png (image/png)]",
		].join("\n"),
	);
});

await test("FAIL-SOFT: non-image attachment never becomes an image part", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "read this",
		attachments: [
			{
				type: "file",
				content: "Zm9v",
				fileName: "brief.pdf",
				mimeType: "application/pdf",
			},
		],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	assert.equal(resolved.images.length, 0);
	assert.equal(
		resolved.content,
		[
			"read this",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- brief.pdf (application/pdf)]",
		].join("\n"),
	);
});

await test("FAIL-SOFT: unsupported image mime (svg) falls back to the note", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "render",
		attachments: [
			imageAttachment({
				mimeType: "image/svg+xml",
				fileName: "vector.svg",
				content: "PHN2Zz48L3N2Zz4=",
			}),
		],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	assert.equal(resolved.images.length, 0, "svg is not a supported image mime");
	assert.equal(
		resolved.content,
		[
			"render",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- vector.svg (image/svg+xml)]",
		].join("\n"),
	);
});

await test("FAIL-SOFT: images beyond MAX_TURN_IMAGES fall back to the note", () => {
	const attachments: AudioAttachment[] = Array.from(
		{ length: MAX_TURN_IMAGES + 2 },
		(_, i) =>
			imageAttachment({ fileName: `img${i}.png`, content: "iVBORw0KGgo=" }),
	);
	const { images, fellBack } = resolveTurnImageParts(attachments);

	assert.equal(images.length, MAX_TURN_IMAGES, "capped at MAX_TURN_IMAGES");
	assert.equal(fellBack.length, 2, "the extra images fell back");
	assert.equal(fellBack[0]!.fileName, `img${MAX_TURN_IMAGES}.png`);
});

await test("image resolution is INERT when resolveImages is not set (note only)", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "here",
		attachments: [imageAttachment({ fileName: "pic.png" })],
		includeNonAudioAttachmentNote: true,
		// resolveImages omitted → byte-for-byte the existing note behavior.
	});

	assert.equal(resolved.images.length, 0, "no images when not opted in");
	assert.equal(
		resolved.content,
		[
			"here",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- pic.png (image/png)]",
		].join("\n"),
	);
});

await test("mixed turn: image becomes a part, pdf still rides the note", async () => {
	const resolved = await resolveVoiceMessageContent({
		env,
		content: "compare these",
		attachments: [
			imageAttachment({ fileName: "chart.png" }),
			{
				type: "file",
				content: "Zm9v",
				fileName: "notes.pdf",
				mimeType: "application/pdf",
			},
		],
		includeNonAudioAttachmentNote: true,
		resolveImages: true,
	});

	assert.equal(resolved.images.length, 1, "the png is a model image part");
	assert.equal(resolved.images[0]!.fileName, "chart.png");
	assert.equal(
		resolved.content,
		[
			"compare these",
			"",
			"[Attachments received (not yet processed by this tedi):",
			"- notes.pdf (application/pdf)]",
		].join("\n"),
		"only the non-image file remains in the note",
	);
});
