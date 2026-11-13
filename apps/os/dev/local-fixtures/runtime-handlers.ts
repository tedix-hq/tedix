/**
 * Local fixture handlers: Kernel and cognitive runtime procedures
 * (conversations, runs, messages).
 */

import type {
	HomeMessage,
	HomeRun,
	ListHomeConversationsInput,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import { DELEGATION_WORK_ITEM, nextId, now, ORG_ID, RpcError } from "./core";
import { CANNED_REPLY, findConversation, findHomeRun } from "./lookups";
import { runSteeringMessages, state } from "./state";
import { TOOL_EVENTS } from "./tedis";

export const runtimeHandlers: Record<string, (input: never) => unknown> = {
	// --- tedi detail: telemetry, authority, growth ---
	"cognitiveRuntime/readMessages": () => ({
		messages: [],
		compaction: null,
		nextCursor: null,
	}),
	"cognitiveRuntime/listEvents": (input: {
		tediId: string;
		kind?: string;
		limit?: number;
	}) => {
		const rows = TOOL_EVENTS.filter(
			(row) =>
				row.tediId === input.tediId &&
				(input.kind === undefined || row.kind === input.kind),
		).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const limit = input.limit ?? 100;
		return { events: rows.slice(0, limit), nextBefore: null };
	},
	"modelCatalog/list": () => ({
		models: [],
		selections: [],
		wiredProviders: [],
		routing: {
			slot: "chat",
			modelRef: null,
			selectedBy: null,
			detail:
				"Local fixtures have no model providers configured and make no model calls.",
			allowed: null,
			selectable: null,
			deniedBy: null,
		},
	}),

	// --- Home / kernel runtime ---
	"kernelRuntime/listConversations": (
		input: ListHomeConversationsInput = {},
	) => ({
		conversations: state.conversations
			.filter(
				(row) =>
					row.hidden !== true &&
					(!input.organizationId ||
						row.organizationId === input.organizationId) &&
					(!input.conversationId || row.id === input.conversationId) &&
					(!input.workspaceId || row.workspaceId === input.workspaceId) &&
					(!input.channel || row.channel === input.channel) &&
					(input.includeArchived || row.status !== "archived") &&
					(!input.search ||
						[row.id, row.title, row.channel].some((value) =>
							value?.toLowerCase().includes(input.search!.toLowerCase()),
						)),
			)
			.slice(0, input.limit ?? 100)
			.map(({ hidden: _hidden, ...conversation }) => conversation),
		nextCursor: null,
	}),
	"kernelRuntime/renameConversation": (input: {
		conversationId: string;
		title: string;
	}) => {
		const conversation = findConversation(input.conversationId);
		conversation.title = input.title;
		conversation.updatedAt = now();
		const { hidden: _hidden, ...row } = conversation;
		return { conversation: row };
	},
	"kernelRuntime/pinConversation": (input: {
		conversationId: string;
		pinned: boolean;
	}) => {
		const conversation = findConversation(input.conversationId);
		conversation.pinnedAt = input.pinned ? now() : null;
		conversation.updatedAt = now();
		const { hidden: _hidden, ...row } = conversation;
		return { conversation: row };
	},
	"kernelRuntime/deleteConversation": (input: { conversationId: string }) => {
		const conversation = findConversation(input.conversationId);
		conversation.hidden = true;
		return {
			ok: true,
			conversationId: conversation.id,
			deletedAt: now(),
			hardDeleted: true,
			canceledRunCount: 0,
		};
	},
	"kernelRuntime/readMessages": (input: { conversationId: string }) => ({
		messages: state.messages.filter(
			(row) => row.conversationId === input.conversationId,
		),
		nextCursor: null,
	}),
	"kernelRuntime/readRun": (input: { runId: string }) => ({
		run: findHomeRun(input.runId),
	}),
	"kernelRuntime/readRunTrace": (input: { runId: string }) => {
		const run = findHomeRun(input.runId);
		const active = run.status === "queued" || run.status === "running";
		const branches =
			run.delegatedTediId && run.childRunId
				? [
						{
							delegatedTediId: run.delegatedTediId,
							childRunId: run.childRunId,
							workItemId: DELEGATION_WORK_ITEM,
							status: run.status,
							observedRunIds: [run.childRunId],
							eventIds: Array.from(
								{ length: 21 },
								(_, i) => `${run.childRunId}:${i}`,
							),
							auditEventIds: [],
							toolEventIds: [`${run.childRunId}:3`],
							workstationEventIds: [],
							artifactIds: [],
							finalMessageEventId: null,
							terminalEventId: null,
							latestEventAt: run.updatedAt ?? run.createdAt,
							evidenceAvailable: true,
							truncated: false,
						},
					]
				: [];
		const gaps = active
			? [
					"parent_not_terminal",
					...branches.map(
						(branch) => `child_not_terminal:${branch.childRunId}`,
					),
					"request_acceptance_unverified",
				]
			: [];
		return {
			trace: {
				version: "home-run-trace.v1",
				organizationId: ORG_ID,
				conversationId: run.conversationId,
				homeRunId: run.id,
				traceBundleId: null,
				harnessVersionId: null,
				status: run.status,
				parentEventIds: [`${run.id}:0`, `${run.id}:1`],
				branches,
				wakeReceipts: [],
				synthesis: [],
				latency: {
					parentElapsedMs:
						run.completedAt && run.startedAt
							? Date.parse(run.completedAt) - Date.parse(run.startedAt)
							: null,
					maxWakeQueueMs: null,
					finalWakeToSynthesisMs: null,
				},
				eventIds: {
					kernel: [`${run.id}:0`, `${run.id}:1`],
					tedi: [],
					audit: [],
				},
				artifactIds: [],
				health: {
					status: "healthy",
					findings: [],
					counts: { errors: 0, warnings: 0 },
				},
				complete: gaps.length === 0,
				gaps,
				assembledAt: now(),
				sources: ["kernel_runtime_events"],
			},
		};
	},

	"kernelRuntime/readChildRunEvidence": (input: {
		delegatedTediId: string;
		childRunId: string;
	}) => {
		const run = state.homeRuns.find(
			(row) => row.childRunId === input.childRunId,
		);
		if (!run) throw new RpcError("NOT_FOUND", "Child run not found");
		const active = run.status === "running";
		const toolListing = JSON.stringify([
			{
				callable: "memory.search_memory_graph",
				namespace: "memory",
				description: "Search memory graph.",
				annotations: { readOnlyHint: true },
			},
		]);
		return {
			evidence: {
				organizationId: ORG_ID,
				delegatedTediId: input.delegatedTediId,
				childRunId: input.childRunId,
				workItemId: DELEGATION_WORK_ITEM,
				status: run.status,
				stopReason: null,
				// The live defect: a running child's preview is intermediate tool
				// output wrapped in a truncation envelope.
				preview: active
					? `Raw result: \`\`\`json\n${JSON.stringify({
							__tedix_truncated: true,
							originalChars: 8211,
							originalType: "array",
							preview: toolListing,
						})}\n\`\`\``
					: "Week 32 revenue closed at **412,000 MXN**, up 6% week over week.\n\n- Subscriptions: 318,000 MXN\n- Services: 94,000 MXN\n\nNo memory entry contradicts these figures.",
				events: [
					{
						id: `${input.childRunId}:3`,
						organizationId: ORG_ID,
						tediId: input.delegatedTediId,
						runId: input.childRunId,
						kind: "tool.completed",
						payload: {
							name: "memory.search_memory_graph",
							result: { matches: 2 },
						},
						createdAt: run.startedAt ?? run.createdAt,
					},
				],
				artifacts: [],
				control: {
					canStop: active,
					reason: active ? "running" : "terminal",
					state: active ? "stoppable" : "terminal",
				},
			},
		};
	},
	"kernelRuntime/readRunSet": (input: { conversationId: string }) => {
		const runs = state.homeRuns.filter(
			(row) => row.conversationId === input.conversationId,
		);
		return {
			runSet: {
				organizationId: ORG_ID,
				conversationId: input.conversationId,
				activeRunIds: runs
					.filter((row) => row.status === "queued" || row.status === "running")
					.map((row) => row.id),
				runs,
				approvalMirrors: {},
				updatedAt: now(),
			},
		};
	},
	"kernelRuntime/readConversationCharges": (input: {
		conversationId: string;
	}) => {
		const runs = state.homeRuns.filter(
			(row) => row.conversationId === input.conversationId,
		);
		// Sample data: each completed run settled a fictional EUR 0.0042.
		const settled = runs.filter((row) => row.status === "completed").length;
		return {
			currency: "eur" as const,
			chargedMicros: settled * 4_200,
			chargeCount: settled,
			runCount: runs.length,
		};
	},
	"kernelRuntime/listPendingHomeDelegations": () => ({
		runSet: {
			organizationId: ORG_ID,
			conversationId: "__pending-home-delegations__",
			activeRunIds: [],
			runs: [],
			approvalMirrors: {},
			updatedAt: now(),
		},
	}),
	"kernelRuntime/readRunEvents": (input: { runId: string }) => {
		const run = state.homeRuns.find((row) => row.id === input.runId);
		const outputMessage = run
			? state.messages.find((row) => row.id === run.outputMessageId)
			: undefined;
		const events =
			run && outputMessage
				? [
						{
							id: `${run.id}:0`,
							kind: "run.started",
							conversationId: run.conversationId,
							runId: run.id,
							sequence: 0,
							createdAt: run.createdAt,
						},
						{
							id: `${run.id}:1`,
							kind: "message.completed",
							conversationId: run.conversationId,
							runId: run.id,
							messageId: outputMessage.id,
							sequence: 1,
							payload: { content: outputMessage.content },
							createdAt: outputMessage.createdAt,
						},
					]
				: [];
		return {
			events,
			stream: {
				streamId: `stream-${input.runId}`,
				offset: 0,
				nextOffset: events.length,
				closed: true,
				terminalEventId:
					events.length > 0 ? events[events.length - 1]?.id : null,
				submissionId: null,
			},
		};
	},
	"kernelRuntime/readConversationEvents": (input: {
		conversationId: string;
		offset?: number;
	}) => ({
		events: [],
		stream: {
			streamId: `home:conversation:${input.conversationId}`,
			offset: input.offset ?? 0,
			nextOffset: input.offset ?? 0,
			closed: false,
		},
	}),
	"kernelRuntime/respondApproval": (input: { runId: string }) => ({
		run: findHomeRun(input.runId),
		assignments: [],
	}),
	"kernelRuntime/steerRun": (input: {
		runId: string;
		instruction: string;
		idempotencyKey?: string;
	}) => {
		const run = findHomeRun(input.runId);
		if (run.status !== "queued" && run.status !== "running")
			throw new RpcError("CONFLICT", "This run has ended");
		const id = input.idempotencyKey ?? nextId();
		const messages = runSteeringMessages.get(run.id) ?? [];
		const prior = messages.find((message) => message.id === id);
		if (prior && prior.content !== input.instruction)
			throw new RpcError("CONFLICT", "Steering id reused");
		if (!prior)
			runSteeringMessages.set(run.id, [
				...messages,
				{ id, content: input.instruction, status: "queued" },
			]);
		return { run };
	},
	"kernelRuntime/controlRunSteering": (input: {
		runId: string;
		action: "inspect" | "withdraw";
	}) => {
		findHomeRun(input.runId);
		const messages = runSteeringMessages.get(input.runId) ?? [];
		if (input.action === "inspect") return { messages };
		const withdrawn = messages
			.filter((message) => message.status === "queued")
			.map((message) => ({ ...message, status: "withdrawn" as const }));
		runSteeringMessages.set(
			input.runId,
			messages.map((message) =>
				message.status === "queued"
					? { ...message, status: "withdrawn" }
					: message,
			),
		);
		return { messages: withdrawn };
	},
	"kernelRuntime/cancelRun": (input: { runId: string }) => {
		const run = findHomeRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		run.updatedAt = run.completedAt;
		return { run };
	},
	"kernelRuntime/retryRun": (input: { runId: string }) => {
		const failed = findHomeRun(input.runId);
		const retried: HomeRun = {
			...failed,
			id: nextId(),
			status: "queued",
			startedAt: null,
			completedAt: null,
			createdAt: now(),
			updatedAt: now(),
		};
		state.homeRuns.push(retried);
		return { run: retried, newRunId: retried.id };
	},
	// Fixture-only upload acknowledgement; production validation/storage lives in API.
	"kernelRuntime/uploadAttachment": (input: TediMessageAttachment) => ({
		...input,
		content: `tedix-attachment:${nextId().replaceAll("-", "").repeat(2)}`,
	}),
	"kernelRuntime/enqueueMessage": (input: {
		conversationId?: string;
		content: string;
		idempotencyKey?: string;
		attachments?: HomeMessage["attachments"];
	}) => {
		const runId = input.idempotencyKey ?? nextId();
		const existing = state.homeRuns.find((run) => run.id === runId);
		if (existing) {
			if (
				input.conversationId &&
				existing.conversationId !== input.conversationId
			) {
				throw new RpcError(
					"CONFLICT",
					"This idempotency key is already bound to a different Home identity",
				);
			}
			return {
				idempotencyKey: runId,
				conversationId: existing.conversationId,
				status: "queued" as const,
				run: existing,
				assistantMessage: state.messages.find(
					(message) => message.id === existing.outputMessageId,
				),
			};
		}
		const timestamp = now();
		let conversation = state.conversations.find(
			(row) => row.id === input.conversationId,
		);
		if (!conversation) {
			conversation = {
				id: input.conversationId ?? nextId(),
				organizationId: ORG_ID,
				title: input.content.slice(0, 60) || "New conversation",
				status: "active",
				channel: "os",
				lastMessageAt: timestamp,
				messageCount: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
				pinnedAt: null,
				origin: "human",
			};
			state.conversations.push(conversation);
		}
		const run: HomeRun = {
			id: runId,
			organizationId: ORG_ID,
			conversationId: conversation.id,
			status: "completed",
			startedAt: timestamp,
			completedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
			usage: {
				pricing: null,

				inputTokens: 620,
				outputTokens: 96,
				reasoningTokens: 24,
				totalTokens: 716,
				costUsd: 0.0052,
			},
		};
		const userMessage: HomeMessage = {
			id: `${runId}:input`,
			organizationId: ORG_ID,
			conversationId: conversation.id,
			runId: run.id,
			role: "user",
			status: "completed",
			content: input.content,
			attachments: input.attachments,
			createdAt: timestamp,
		};
		const assistantMessage: HomeMessage = {
			id: `${runId}:assistant`,
			organizationId: ORG_ID,
			conversationId: conversation.id,
			runId: run.id,
			role: "assistant",
			status: "completed",
			content: CANNED_REPLY,
			createdAt: timestamp,
		};
		run.inputMessageId = userMessage.id;
		run.outputMessageId = assistantMessage.id;
		state.messages.push(userMessage, assistantMessage);
		state.homeRuns.push(run);
		conversation.lastMessageAt = timestamp;
		conversation.updatedAt = timestamp;
		conversation.messageCount = (conversation.messageCount ?? 0) + 2;
		return {
			idempotencyKey: runId,
			conversationId: conversation.id,
			status: "queued" as const,
			run,
			assistantMessage,
		};
	},
};
