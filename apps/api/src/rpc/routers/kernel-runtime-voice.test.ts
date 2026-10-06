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
	tediApprovalRequests,
	type tediArtifacts,
	type tediRuntimeEvents,
	tedis,
	workItemComments,
	workItems,
} from "@tedix/db/schema";
import type { TranscriptionResult } from "@tedix/voice/stt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { kernelRuntimeContractRouter } from "./kernel-runtime";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";

const ORG_ID = "org-voice-test";

// ── Minimal fake DB (mirrors kernel-runtime.test.ts shape) ──────────────────────

type KernelRuntimeEventRow = typeof kernelRuntimeEvents.$inferSelect;
type KernelRuntimeEventInsert = typeof kernelRuntimeEvents.$inferInsert;
type KernelRuntimeRunRow = typeof kernelRuntimeRuns.$inferSelect;
type KernelRuntimeRunInsert = typeof kernelRuntimeRuns.$inferInsert;

function normalizeEventInsert(
	input: KernelRuntimeEventInsert,
): KernelRuntimeEventRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId ?? null,
		messageId: input.messageId ?? null,
		causeEventId: input.causeEventId ?? null,
		delegatedTediId: input.delegatedTediId ?? null,
		childRunId: input.childRunId ?? null,
		sequence: input.sequence ?? null,
		delta: input.delta ?? null,
		payload: input.payload ?? null,
		runtimeBackend: input.runtimeBackend ?? "custom",
		runtimeExternalId: input.runtimeExternalId ?? null,
		runtimeExternalUrl: input.runtimeExternalUrl ?? null,
		runtimeMetadata: input.runtimeMetadata ?? null,
		createdAt: input.createdAt ?? "2026-06-12T08:00:00.000Z",
	};
}

function normalizeRunInsert(
	input: KernelRuntimeRunInsert,
): KernelRuntimeRunRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: input.status ?? "queued",
		inputMessageId: input.inputMessageId ?? null,
		outputMessageId: input.outputMessageId ?? null,
		delegatedTediId: input.delegatedTediId ?? null,
		childRunId: input.childRunId ?? null,
		childConversationId: input.childConversationId ?? null,
		progressValue: input.progressValue ?? null,
		progressLabel: input.progressLabel ?? null,
		progressDetail: input.progressDetail ?? null,
		latestEventKind: input.latestEventKind ?? null,
		latestEventAt: input.latestEventAt ?? null,
		preview: input.preview ?? null,
		runtimeBackend: input.runtimeBackend ?? "custom",
		runtimeExternalId: input.runtimeExternalId ?? null,
		runtimeExternalUrl: input.runtimeExternalUrl ?? null,
		runtimeMetadata: input.runtimeMetadata ?? null,
		metadata: input.metadata ?? null,
		startedAt: input.startedAt ?? null,
		completedAt: input.completedAt ?? null,
		createdAt: input.createdAt ?? "2026-06-12T08:00:00.000Z",
		updatedAt:
			input.updatedAt ?? input.completedAt ?? "2026-06-12T08:00:00.000Z",
	};
}

function createVoiceTestDb() {
	const events: KernelRuntimeEventRow[] = [];
	const runs: KernelRuntimeRunRow[] = [];
	const submissions: Array<typeof runtimeSubmissions.$inferSelect> = [];
	const tediRows: Array<
		Pick<
			typeof tedis.$inferSelect,
			"displayName" | "id" | "name" | "organizationId" | "runtimeKind" | "slug"
		>
	> = [
		{
			displayName: "CTO",
			id: "tedi-cto",
			name: "CTO",
			organizationId: ORG_ID,
			runtimeKind: "agent",
			slug: "cto",
		},
	];
	return {
		events,
		runs,
		insert(table: unknown) {
			if (table === runtimeSubmissions) {
				let value: typeof runtimeSubmissions.$inferInsert;
				return {
					values(input: typeof runtimeSubmissions.$inferInsert) {
						value = input;
						return this;
					},
					onConflictDoNothing() {
						return this;
					},
					onConflictDoUpdate() {
						return this;
					},
					returning() {
						if (submissions.some((row) => row.id === value.id)) return [];
						const row = {
							...value,
							status: "admitted",
							attemptCount: 0,
							currentAttemptId: null,
						} as typeof runtimeSubmissions.$inferSelect;
						submissions.push(row);
						return [row];
					},
				};
			}
			if (
				table !== kernelRuntimeEvents &&
				table !== kernelRuntimeRuns &&
				table !== tediApprovalRequests &&
				table !== workItems &&
				table !== workItemComments
			) {
				// auditEvents and other tables: accept silently for voice tests.
				return {
					values() {
						return this;
					},
					onConflictDoNothing() {
						return this;
					},
					returning() {
						return Promise.resolve([]);
					},
				};
			}
			let rows: Array<KernelRuntimeEventInsert | KernelRuntimeRunInsert> = [];
			let ignoreConflicts = false;
			let selectedSource: PromiseLike<unknown[]> | undefined;
			const builder = {
				select(source: PromiseLike<unknown[]>) {
					selectedSource = source;
					return builder;
				},
				values(
					value:
						| KernelRuntimeEventInsert
						| KernelRuntimeRunInsert
						| Array<KernelRuntimeEventInsert | KernelRuntimeRunInsert>,
				) {
					rows = Array.isArray(value) ? value : [value];
					return this;
				},
				onConflictDoNothing() {
					ignoreConflicts = true;
					return this;
				},
				onConflictDoUpdate() {
					return this;
				},
				async returning() {
					if (selectedSource) rows = (await selectedSource) as typeof rows;
					if (table === kernelRuntimeRuns) {
						const inserted: KernelRuntimeRunRow[] = [];
						for (const row of rows as KernelRuntimeRunInsert[]) {
							if (ignoreConflicts && runs.some((r) => r.id === row.id)) {
								continue;
							}
							const normalized = normalizeRunInsert(row);
							runs.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					const inserted: KernelRuntimeEventRow[] = [];
					for (const row of rows as KernelRuntimeEventInsert[]) {
						if (ignoreConflicts && events.some((e) => e.id === row.id)) {
							continue;
						}
						const normalized = normalizeEventInsert(row);
						events.push(normalized);
						inserted.push(normalized);
					}
					return Promise.resolve(inserted);
				},
			};
			return builder;
		},
		select(selection?: Record<string, unknown>) {
			type AnyRow =
				| KernelRuntimeEventRow
				| KernelRuntimeRunRow
				| typeof tediRuntimeEvents.$inferSelect
				| typeof tediArtifacts.$inferSelect
				| typeof tediApprovalRequests.$inferSelect
				| typeof runtimeSubmissions.$inferSelect
				| (typeof tediRows)[number];
			let selectedRows: AnyRow[] = [];
			let whereClause: unknown;
			let orderByClause: unknown;
			let rowLimit: number | undefined;
			let selectedTable: unknown;
			return {
				from(table: unknown) {
					selectedTable = table;
					const isKernelEventAlias = Object.getOwnPropertySymbols(
						table as object,
					).some(
						(symbol) =>
							(table as Record<symbol, unknown>)[symbol] ===
							"kernel_runtime_events",
					);
					if (table === kernelRuntimeEvents || isKernelEventAlias) {
						selectedRows = [...events] as AnyRow[];
					} else if (table === kernelRuntimeRuns) {
						selectedRows = [...runs] as AnyRow[];
					} else if (table === tedis) {
						selectedRows = [...tediRows] as AnyRow[];
					} else if (table === runtimeSubmissions) {
						selectedRows = [...submissions] as AnyRow[];
					} else {
						selectedRows = [];
					}
					return this;
				},
				where(value: unknown) {
					whereClause = value;
					return this;
				},
				orderBy(value: unknown) {
					orderByClause = value;
					return this;
				},
				limit(value: number) {
					rowLimit = value;
					return this;
				},
				execute() {
					void whereClause;
					void orderByClause;
					if (
						selection &&
						"causeEventId" in selection &&
						selectedTable !== kernelRuntimeEvents
					) {
						const source = selectedRows[0] as
							| Record<string, unknown>
							| undefined;
						if (!source) return [];
						return [
							Object.fromEntries(
								Object.entries(selection).map(([key, field]) => {
									if (key === "causeEventId") return [key, source.id];
									const sqlValue = (
										field as {
											sql?: { queryChunks?: unknown[] };
										}
									).sql?.queryChunks?.[1];
									if (
										(key === "payload" || key === "runtimeMetadata") &&
										typeof sqlValue === "string"
									)
										return [key, JSON.parse(sqlValue)];
									return [key, sqlValue];
								}),
							),
						] as AnyRow[];
					}
					const out =
						rowLimit !== undefined
							? selectedRows.slice(0, rowLimit)
							: selectedRows;
					return out;
				},
				// Drizzle query builders are awaitable.
				then<TResult1 = AnyRow[], TResult2 = never>(
					onfulfilled?:
						| ((value: AnyRow[]) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
				},
			};
		},
		update(table: unknown) {
			let values: Partial<KernelRuntimeRunRow> = {};
			let matched: KernelRuntimeRunRow[] = [];
			return {
				set(value: Partial<KernelRuntimeRunRow>) {
					values = value;
					return this;
				},
				where() {
					if (table === kernelRuntimeRuns) {
						// Apply all pending set values to all runs (fine for tests).
						for (const row of runs) {
							Object.assign(row, values);
						}
						matched = [...runs];
					}
					return this;
				},
				returning() {
					return Promise.resolve(matched);
				},
				// Drizzle query builders are awaitable.
				then<TResult1 = KernelRuntimeRunRow[], TResult2 = never>(
					onfulfilled?:
						| ((
								value: KernelRuntimeRunRow[],
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.resolve(matched).then(onfulfilled, onrejected);
				},
			};
		},
	};
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
