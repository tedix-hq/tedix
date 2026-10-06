import assert from "node:assert/strict";
import type { TediMessage } from "@tedix/api-contract/schemas/cognitive-runtime";
import { projectDurableCompaction } from "@tedix/tedi-session/session-harness";
import {
	buildCompactionLedgerPayload,
	ledgerReadToDurableState,
} from "./compaction-ledger";

const sessionKey = "chat:cold-body";
const replayFingerprint = `sha256:${"c".repeat(64)}`;
const replayCheckpoint = {
	version: 1 as const,
	coveredThroughEntryId: `${sessionKey}:run-1:2`,
	capabilityBindings: [
		{ id: "binding-1", namespace: "github", fingerprint: replayFingerprint },
	],
	artifactRevisions: [],
	pendingApprovals: [],
	workReferences: [],
	toolResultDependencies: [],
	contextSources: [
		{ id: "run-1:2", kind: "ledger_message", fingerprint: replayFingerprint },
	],
	truncated: false,
	checkpointDigest: replayFingerprint,
};
const baseMessage = {
	tediId: "tedi-1",
	conversationId: "cto:chat:cold-body",
	status: "completed",
} as const;
const messages: TediMessage[] = [
	{
		...baseMessage,
		id: "run-1:0",
		role: "user",
		content: "old question",
		createdAt: "2026-08-19T01:00:00.000Z",
	},
	{
		...baseMessage,
		id: "run-1:2",
		role: "assistant",
		content: "old answer",
		createdAt: "2026-08-19T01:00:01.000Z",
	},
	{
		...baseMessage,
		id: "run-2:0",
		role: "user",
		content: "kept question",
		createdAt: "2026-08-19T01:01:00.000Z",
	},
	{
		...baseMessage,
		id: "runtime-note",
		role: "runtime",
		content: "not model context",
		createdAt: "2026-08-19T01:01:01.000Z",
	},
];

const state = ledgerReadToDurableState(sessionKey, {
	messages,
	compaction: {
		summary: "The operator asked an old question and received an answer.",
		firstKeptEntryId: `${sessionKey}:run-2:0`,
		tokensBefore: 314,
		createdAt: "2026-08-19T01:02:00.000Z",
		checkpoint: replayCheckpoint,
	},
});

assert.deepEqual(
	state.entries.map(({ id, role, content }) => ({ id, role, content })),
	[
		{
			id: `${sessionKey}:run-1:0`,
			role: "user",
			content: "old question",
		},
		{
			id: `${sessionKey}:run-1:2`,
			role: "assistant",
			content: "old answer",
		},
		{
			id: `${sessionKey}:run-2:0`,
			role: "user",
			content: "kept question",
		},
	],
	"ledger ids are normalized to the DO entry identity and non-model rows drop",
);
assert.deepEqual(state.compaction, {
	summary: "The operator asked an old question and received an answer.",
	firstKeptEntryId: `${sessionKey}:run-2:0`,
	tokensBefore: 314,
	checkpoint: replayCheckpoint,
});

assert.deepEqual(
	projectDurableCompaction(state.entries, state.compaction).map(
		({ role, content }) => ({ role, content }),
	),
	[
		{
			role: "assistant",
			content: "The operator asked an old question and received an answer.",
		},
		{
			role: "assistant",
			content: [
				"[Replay checkpoint: references only; revalidate capabilities and approvals before acting]",
				JSON.stringify(replayCheckpoint),
			].join("\n"),
		},
		{ role: "user", content: "kept question" },
	],
	"a cold/body-swapped read applies the persisted summary and cut boundary",
);

assert.deepEqual(
	buildCompactionLedgerPayload(sessionKey, {
		compacted: true,
		summary: "full durable summary",
		firstKeptEntryId: `${sessionKey}:run-2:0`,
		tokensBefore: 314,
		markerTs: 1_755_562_920_000,
		checkpoint: replayCheckpoint,
	}),
	{
		source: "isolate-compaction",
		sessionKey,
		summary: "full durable summary",
		firstKeptEntryId: `${sessionKey}:run-2:0`,
		tokensBefore: 314,
		summaryChars: 20,
		checkpoint: replayCheckpoint,
	},
	"context.compacted payload retains the complete summary and cut metadata",
);

assert.throws(
	() =>
		buildCompactionLedgerPayload(sessionKey, {
			compacted: true,
			firstKeptEntryId: "cut",
			tokensBefore: 1,
		}),
	/missing durable overlay fields/,
	"a compacted result cannot emit an incomplete durable overlay",
);

console.log("compaction-ledger OK");
