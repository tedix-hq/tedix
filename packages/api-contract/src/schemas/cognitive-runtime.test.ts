import { describe, expect, it } from "vite-plus/test";
import {
	classifyRunTerminalReason,
	ListConversationsInputSchema,
	ReadMessagesOutputSchema,
	TediConversationCompactionSchema,
	TediMessageSchema,
	CreateRedactedArtifactRevisionInputSchema,
	GetArtifactReleaseReviewInputSchema,
} from "./cognitive-runtime";
import { ListHomeConversationsInputSchema } from "./kernel-runtime";

describe("ListConversationsInputSchema", () => {
	it("accepts only composite conversation cursors", () => {
		expect(
			ListConversationsInputSchema.parse({
				tediId: "tedi-1",
				cursor: "2026-07-01T08:00:00.000Z|home:chat",
			}).cursor,
		).toBe("2026-07-01T08:00:00.000Z|home:chat");
		expect(() =>
			ListConversationsInputSchema.parse({
				tediId: "tedi-1",
				cursor: "2026-07-01T08:00:00.000Z",
			}),
		).toThrow("Invalid conversation cursor");
		expect(() =>
			ListHomeConversationsInputSchema.parse({
				cursor: "2026-07-01T08:00:00.000Z",
			}),
		).toThrow("Invalid conversation cursor");
	});
});

describe("artifact release review schemas", () => {
	it("binds a candidate to the exact source digest", () => {
		expect(
			CreateRedactedArtifactRevisionInputSchema.safeParse({
				tediId: "tedi-1",
				parentArtifactId: "artifact-1",
				expectedParentDigest: "a".repeat(64),
				content: "redacted",
				idempotencyKey: "request-1",
			}).success,
		).toBe(true);
		expect(
			CreateRedactedArtifactRevisionInputSchema.safeParse({
				tediId: "tedi-1",
				parentArtifactId: "artifact-1",
				content: "redacted",
				idempotencyKey: "request-1",
			}).success,
		).toBe(false);
	});

	it("requires exactly one source or candidate review target", () => {
		expect(
			GetArtifactReleaseReviewInputSchema.safeParse({
				tediId: "tedi-1",
				sourceArtifactId: "artifact-1",
			}).success,
		).toBe(true);
		expect(
			GetArtifactReleaseReviewInputSchema.safeParse({
				tediId: "tedi-1",
				candidateId: "candidate-1",
			}).success,
		).toBe(true);
		expect(
			GetArtifactReleaseReviewInputSchema.safeParse({ tediId: "tedi-1" })
				.success,
		).toBe(false);
		expect(
			GetArtifactReleaseReviewInputSchema.safeParse({
				tediId: "tedi-1",
				sourceArtifactId: "artifact-1",
				candidateId: "candidate-1",
			}).success,
		).toBe(false);
	});
});

describe("TediConversationCompactionSchema", () => {
	const fingerprint = `sha256:${"a".repeat(64)}`;

	it("parses the durable compaction marker projected by readMessages", () => {
		const compaction = TediConversationCompactionSchema.parse({
			summary: "Earlier context established the launch constraints.",
			firstKeptEntryId: "entry-42",
			tokensBefore: 18_250,
			createdAt: "2026-08-19T06:00:00.000Z",
		});

		expect(compaction).toEqual({
			summary: "Earlier context established the launch constraints.",
			firstKeptEntryId: "entry-42",
			tokensBefore: 18_250,
			createdAt: "2026-08-19T06:00:00.000Z",
		});
	});

	it("parses a bounded replay-complete checkpoint without requiring it on legacy rows", () => {
		const checkpoint = {
			version: 1 as const,
			coveredThroughEntryId: "entry-41",
			capabilityBindings: [
				{ id: "binding-1", namespace: "github", fingerprint },
			],
			artifactRevisions: [{ id: "artifact-1", revision: "rev-7", fingerprint }],
			pendingApprovals: [
				{ id: "approval-1", status: "pending" as const, fingerprint },
			],
			workReferences: [
				{ id: "work-1", kind: "work_item" as const, fingerprint },
			],
			toolResultDependencies: [
				{ id: "event-9", toolCallId: "call-9", fingerprint },
			],
			contextSources: [
				{ id: "message-1", kind: "ledger_message", fingerprint },
			],
			truncated: false,
			checkpointDigest: fingerprint,
		};
		const parsed = TediConversationCompactionSchema.parse({
			summary: "summary",
			firstKeptEntryId: "entry-42",
			tokensBefore: 10,
			createdAt: "2026-08-19T06:00:00.000Z",
			checkpoint,
		});
		expect(parsed.checkpoint).toEqual(checkpoint);
		expect(
			TediConversationCompactionSchema.parse({
				summary: "legacy",
				firstKeptEntryId: "entry-42",
				tokensBefore: 10,
				createdAt: "2026-08-19T06:00:00.000Z",
			}).checkpoint,
		).toBeUndefined();
	});

	it("requires an explicit compaction state in readMessages output", () => {
		expect(
			ReadMessagesOutputSchema.parse({ messages: [], compaction: null }),
		).toEqual({ messages: [], compaction: null });
		expect(() => ReadMessagesOutputSchema.parse({ messages: [] })).toThrow();
	});
});

describe("TediMessageSchema", () => {
	/**
	 * Ψ5 Part B: schema-level proof that the optional timing fields parse
	 * cleanly. Historical ledger rows that omit timing MUST still parse so
	 * hydrated history reads do not break on legacy data.
	 */
	it("accepts ISO startedAt and completedAt timing fields", () => {
		const parsed = TediMessageSchema.parse({
			id: "message-1",
			tediId: "tedi-1",
			conversationId: "agent:main:main",
			runId: "run-1",
			role: "assistant",
			status: "completed",
			content: "Hello",
			createdAt: "2026-05-25T08:00:01.000Z",
			startedAt: "2026-05-25T08:00:01.000Z",
			completedAt: "2026-05-25T08:00:05.000Z",
		});
		expect(parsed.startedAt).toBe("2026-05-25T08:00:01.000Z");
		expect(parsed.completedAt).toBe("2026-05-25T08:00:05.000Z");
	});

	it("treats startedAt and completedAt as optional (legacy rows)", () => {
		const parsed = TediMessageSchema.parse({
			id: "message-1",
			tediId: "tedi-1",
			conversationId: "agent:main:main",
			role: "user",
			status: "completed",
			content: "Hi",
			createdAt: "2026-05-25T08:00:00.000Z",
		});
		expect(parsed.startedAt).toBeUndefined();
		expect(parsed.completedAt).toBeUndefined();
	});

	it("accepts explicit null for startedAt (nullable contract)", () => {
		const parsed = TediMessageSchema.parse({
			id: "message-1",
			tediId: "tedi-1",
			conversationId: "agent:main:main",
			role: "assistant",
			status: "completed",
			content: "",
			createdAt: "2026-05-25T08:00:00.000Z",
			startedAt: null,
			completedAt: null,
		});
		expect(parsed.startedAt).toBeNull();
		expect(parsed.completedAt).toBeNull();
	});
});

describe("classifyRunTerminalReason", () => {
	// No-prose failures retain the category of their terminal error.
	it("only labels a genuine no-content turn empty_message", () => {
		expect(
			classifyRunTerminalReason({
				error: "empty_assistant_message",
				hasAssistantContent: false,
			}),
		).toBe("empty_message");
	});

	it("classifies a step timeout as a real error, not empty_message", () => {
		// app-operations / grounding-review timeout: no prose, but NOT empty.
		expect(
			classifyRunTerminalReason({
				error: "Execution timed out after 600000ms",
				hasAssistantContent: false,
			}),
		).toBe("llm_error");
	});

	it("classifies a fail-soft tool failure as a real error", () => {
		expect(
			classifyRunTerminalReason({
				error: "cron_tool_failure",
				hasAssistantContent: false,
			}),
		).toBe("llm_error");
	});

	it("classifies a deploy/OOM/storage reset as runtime_dropped", () => {
		for (const error of [
			"Durable Object reset because its code was updated.",
			"isolate exceeded its memory limit",
			"internal error: durable object was reset",
		]) {
			expect(
				classifyRunTerminalReason({ error, hasAssistantContent: false }),
			).toBe("runtime_dropped");
		}
	});

	it("recovery exhaustion wins over content/error text", () => {
		expect(
			classifyRunTerminalReason({
				error: "empty_assistant_message",
				hasAssistantContent: false,
				recovery: true,
			}),
		).toBe("recovery_exhausted");
	});

	it("an errored turn that produced partial prose is llm_error", () => {
		expect(
			classifyRunTerminalReason({
				error: "stream aborted mid-answer",
				hasAssistantContent: true,
			}),
		).toBe("llm_error");
	});
});

describe("known workstation observer terminal attribution", () => {
	const envelope =
		"workflow errored before terminal: Computer execution status read failed: workstation job observation unavailable";
	for (const hasAssistantContent of [false, true]) {
		it(`omits unsupported attribution with assistant content=${hasAssistantContent}`, () => {
			for (const error of [
				envelope,
				`${envelope}; diagnostics={"phase":"status"}`,
				...[
					"Durable Object reset because its code was updated",
					"out of memory",
					"empty_assistant_message",
				].map(
					(detail) => `${envelope}; diagnostics=${JSON.stringify({ detail })}`,
				),
			]) {
				expect(
					classifyRunTerminalReason({ error, hasAssistantContent }),
				).toBeUndefined();
				expect(
					classifyRunTerminalReason({
						error,
						hasAssistantContent,
						recovery: true,
					}),
				).toBe("recovery_exhausted");
			}
		});

		it(`rejects observer lookalikes with assistant content=${hasAssistantContent}`, () => {
			for (const error of [
				`"${envelope}"`,
				`provider quoted: ${envelope}`,
				`prefix ${envelope}; diagnostics={}`,
				`${envelope}_lookalike`,
				`${envelope}X; diagnostics={}`,
				`${envelope}-ish`,
				`${envelope}; diagnostics_lookalike={}`,
				`${envelope}; diagnostic={}`,
				`${envelope} diagnostics={}`,
				`${envelope}.`,
				envelope.toUpperCase(),
			]) {
				expect(classifyRunTerminalReason({ error, hasAssistantContent })).toBe(
					"llm_error",
				);
			}
		});
	}
});
