import { createApiSqliteFixture } from "./__tests__/api-sqlite";
/**
 * kernel-runtime-voice.test.ts — voice transcription in the kernel path.
 *
 * Covers the STT seam added to `enqueueMessage`'s `kernelEligible` branch:
 *   1. audio attachment → kernel receives the transcript in its `content`.
 *   2. STT failure → fail-soft note in content, turn still runs.
 *   3. no audio attachment → content unchanged.
 *
 * Tests are additive to kernel-runtime.test.ts and intentionally small: they pin
 * ONLY the voice-specific content-substitution contract so future refactors in
 * the broader suite don't need to touch these.
 */

import { createRouterClient } from "@orpc/server";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	runtimeSubmissions,
	tedis,
} from "@tedix/db/schema";
import type { TranscriptionResult } from "@tedix/voice/stt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { kernelRuntimeContractRouter } from "./kernel-runtime";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";

const ORG_ID = "org-voice-test";

function createVoiceTestDb() {
	const fixture = createApiSqliteFixture();
	fixture.seed(tedis, [
		{
			id: "tedi-cto",
			name: "CTO",
			displayName: "CTO",
			slug: "cto",
			organizationId: ORG_ID,
			runtimeKind: "agent",
		},
	]);
	return Object.assign(fixture.db, {
		events:
			fixture.rows<typeof kernelRuntimeEvents.$inferSelect>(
				kernelRuntimeEvents,
			),
		runs: fixture.rows<typeof kernelRuntimeRuns.$inferSelect>(
			kernelRuntimeRuns,
		),
		submissions:
			fixture.rows<typeof runtimeSubmissions.$inferSelect>(runtimeSubmissions),
	});
}

function createContext(db: ReturnType<typeof createVoiceTestDb>): BaseContext {
	const waitUntilPromises: Promise<unknown>[] = [];
	return {
		apiKey: {
			id: "api-key-voice",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: db as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/kernel-runtime"),
		waitUntil: (promise) => {
			waitUntilPromises.push(promise);
		},
		waitUntilPromises,
	} as BaseContext & { waitUntilPromises: Promise<unknown>[] };
}

function createClient(context: BaseContext) {
	return createRouterClient(kernelRuntimeContractRouter, { context });
}

/** Minimal audio attachment — "Hello" base64-encoded, good enough for the STT seam. */
function audioAttachment(
	overrides: Partial<{
		content: string;
		durationMs: number;
		fileName: string;
		mimeType: string;
		size: number;
	}> = {},
) {
	return {
		content: "SGVsbG8=", // "Hello" in base64
		fileName: "voice.webm",
		mimeType: "audio/webm",
		type: "audio" as const,
		...overrides,
	};
}

/** Minimal kernel stub that returns an answer-in-home result, capturing args. */
function makeKernel(capturedArgs: { content?: string } = {}) {
	return vi.fn(async (args: { content: string }) => {
		capturedArgs.content = args.content;
		return {
			assistantContent: "OK",
			route: {
				routeKind: "answer_in_home" as const,
				rationale: "voice test",
				risk: "low" as const,
				confidence: 0.9,
				effortClass: "single_read" as const,
				answer: "OK",
				targetTediId: null,
				targetTediLabel: null,
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
			},
		};
	});
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("kernel runtime — voice transcription in kernel path", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setTranscribeForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
	});

	it("substitutes kernel content with the transcript when an audio attachment is present", async () => {
		// Arrange: STT returns "Please schedule a meeting tomorrow".
		// Tedix OS always sends content: min 1 char; audio-only messages arrive with a
		// single space or whisper placeholder — we use a real-world short text here.
		const sttResult: TranscriptionResult = {
			text: "Please schedule a meeting tomorrow",
			provider: "azure",
		};
		const transcribeSpy = vi.fn(async () => sttResult);
		kernelRuntimeTestHooks.setTranscribeForTest(transcribeSpy);

		const capturedArgs: { content?: string } = {};
		const kernel = makeKernel(capturedArgs);
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		// Act — content is a minimal non-empty placeholder (contract min:1)
		await client.enqueueMessage({
			conversationId: "home:voice-1",
			content: " ",
			idempotencyKey: "voice-sub-1",
			attachments: [audioAttachment({ durationMs: 4200, size: 5 })],
		});

		// Assert: the kernel received the transcribed content, not the raw whitespace
		expect(kernel).toHaveBeenCalledTimes(1);
		const kernelContent = capturedArgs.content ?? "";
		expect(kernelContent).toContain("Please schedule a meeting tomorrow");
		expect(kernelContent).toContain("[Voice message transcript]");
		expect(transcribeSpy).toHaveBeenCalledTimes(1);
		const received = db.events.find(
			(event) => event.kind === "message.received",
		);
		expect(received?.payload).toMatchObject({
			role: "user",
			content: "[Voice message transcript]\nPlease schedule a meeting tomorrow",
			metadata: {
				voiceTranscript: {
					fileName: "voice.webm",
					mimeType: "audio/webm",
					provider: "azure",
					transcript: "Please schedule a meeting tomorrow",
				},
			},
		});
		const messages = await client.readMessages({
			conversationId: "home:voice-1",
			limit: 5,
		});
		const userMessage = messages.messages.find(
			(message) => message.role === "user",
		);
		expect(userMessage).toMatchObject({
			content: "[Voice message transcript]\nPlease schedule a meeting tomorrow",
			attachments: [
				{
					content: "data:audio/webm;base64,SGVsbG8=",
					durationMs: 4200,
					fileName: "voice.webm",
					mimeType: "audio/webm",
					size: 5,
					type: "audio",
				},
			],
		});
	});

	it("prepends typed user text before the transcript block when both are present", async () => {
		const sttResult: TranscriptionResult = {
			text: "Book a flight to Berlin",
			provider: "azure",
		};
		kernelRuntimeTestHooks.setTranscribeForTest(vi.fn(async () => sttResult));

		const capturedArgs: { content?: string } = {};
		kernelRuntimeTestHooks.setKernelForTest(makeKernel(capturedArgs));

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		await client.enqueueMessage({
			conversationId: "home:voice-2",
			content: "follow up on this note:",
			idempotencyKey: "voice-sub-2",
			attachments: [audioAttachment()],
		});

		// The format mirrors buildTranscriptContent: "{userText}\n\n[Voice message transcript]\n{transcript}"
		const kernelContent = capturedArgs.content ?? "";
		expect(kernelContent).toMatch(
			/^follow up on this note:\n\n\[Voice message transcript\]\nBook a flight to Berlin$/,
		);
	});

	it("uses '(no speech detected)' when STT succeeds but returns empty text", async () => {
		const sttResult: TranscriptionResult = {
			text: "",
			provider: "workers-ai",
		};
		kernelRuntimeTestHooks.setTranscribeForTest(vi.fn(async () => sttResult));

		const capturedArgs: { content?: string } = {};
		kernelRuntimeTestHooks.setKernelForTest(makeKernel(capturedArgs));

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		// Minimal non-empty content (contract min:1); no user-typed text
		await client.enqueueMessage({
			conversationId: "home:voice-3",
			content: " ",
			idempotencyKey: "voice-silent-1",
			attachments: [audioAttachment()],
		});

		const kernelContent = capturedArgs.content ?? "";
		expect(kernelContent).toContain("(no speech detected)");
	});

	it("fails soft on STT error — turn still runs with an error note in content", async () => {
		kernelRuntimeTestHooks.setTranscribeForTest(
			vi.fn(async () => {
				throw new Error("Azure STT timed out after 20000ms");
			}),
		);

		const capturedArgs: { content?: string } = {};
		const kernel = makeKernel(capturedArgs);
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		// Should NOT throw — the turn must still complete (contract min:1 content)
		const result = await client.enqueueMessage({
			conversationId: "home:voice-4",
			content: " ",
			idempotencyKey: "voice-fail-1",
			attachments: [audioAttachment()],
		});

		// Turn ran (kernel was called once)
		expect(kernel).toHaveBeenCalledTimes(1);

		// Content contains the fail-soft note (matches buildFailedTranscriptContent)
		const kernelContent = capturedArgs.content ?? "";
		expect(kernelContent).toContain("[audio transcription failed:");
		expect(kernelContent).toContain("Azure STT timed out");

		// The API response is still a valid completed turn
		expect(result.status).not.toBe("failed");
	});

	it("does not call STT when there is no audio attachment", async () => {
		const transcribeSpy = vi.fn(async (): Promise<TranscriptionResult> => ({
			text: "should not be called",
			provider: "azure",
		}));
		kernelRuntimeTestHooks.setTranscribeForTest(transcribeSpy);

		const capturedArgs: { content?: string } = {};
		kernelRuntimeTestHooks.setKernelForTest(makeKernel(capturedArgs));

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		await client.enqueueMessage({
			conversationId: "home:voice-5",
			content: "plain text message, no audio",
			idempotencyKey: "no-audio-1",
		});

		// STT helper must not have been invoked
		expect(transcribeSpy).not.toHaveBeenCalled();

		// Kernel receives the original unmodified content
		expect(capturedArgs.content).toBe("plain text message, no audio");
	});

	it("does not call STT when attachments array has no audio type", async () => {
		const transcribeSpy = vi.fn(async (): Promise<TranscriptionResult> => ({
			text: "should not be called",
			provider: "azure",
		}));
		kernelRuntimeTestHooks.setTranscribeForTest(transcribeSpy);

		const capturedArgs: { content?: string } = {};
		kernelRuntimeTestHooks.setKernelForTest(makeKernel(capturedArgs));

		const db = createVoiceTestDb();
		const client = createClient(createContext(db));

		await client.enqueueMessage({
			conversationId: "home:voice-6",
			content: "message with file attachment",
			idempotencyKey: "file-attach-1",
			attachments: [
				{
					content: "data:text/plain;base64,SGVsbG8=",
					fileName: "report.txt",
					mimeType: "text/plain",
					type: "file",
				},
			],
		});

		expect(transcribeSpy).not.toHaveBeenCalled();
		expect(capturedArgs.content).toBe("message with file attachment");
	});
});
