import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceChatLedgerEvent } from "./workspace-chat-protocol";
import {
	activeTurn,
	applyWorkspaceChatEvent,
	applyWorkspaceChatEvents,
	elapsedLabel,
	formatUsage,
	initialWorkspaceChatState,
	markPendingSend,
	pendingApproval,
} from "./workspace-chat-state";

const at = (seconds: number) =>
	new Date(Date.UTC(2026, 10, 7, 12, 0, seconds)).toISOString();

const turn: WorkspaceChatLedgerEvent[] = [
	{
		seq: 1,
		at: at(0),
		conversationId: "c1",
		type: "turn.started",
		turnId: "t1",
		text: "How many challenges are open?",
		authorId: "person:aaron",
		authorKind: "person",
	},
	{
		seq: 2,
		at: at(1),
		conversationId: "c1",
		type: "step.started",
		turnId: "t1",
		stepId: "s1",
		label: "Reading Challenges sheet",
		kind: "read",
	},
	{
		seq: 3,
		at: at(2),
		conversationId: "c1",
		type: "step.finished",
		turnId: "t1",
		stepId: "s1",
		status: "ok",
		summary: "12 rows",
		durationMs: 900,
	},
	{
		seq: 4,
		at: at(3),
		conversationId: "c1",
		type: "assistant.delta",
		turnId: "t1",
		messageId: "m1",
		text: "Twelve ",
	},
	{
		seq: 5,
		at: at(3),
		conversationId: "c1",
		type: "assistant.delta",
		turnId: "t1",
		messageId: "m1",
		text: "are open.",
	},
	{
		seq: 6,
		at: at(4),
		conversationId: "c1",
		type: "assistant.done",
		turnId: "t1",
		messageId: "m1",
		text: "Twelve are open.",
		usage: { inputTokens: 1000, outputTokens: 20, costCents: 2 },
		model: "mock",
	},
	{
		seq: 7,
		at: at(4),
		conversationId: "c1",
		type: "turn.finished",
		turnId: "t1",
		status: "done",
		durationMs: 4000,
	},
];

describe("applyWorkspaceChatEvent", () => {
	it("folds a turn's events into one row with steps, prose and usage", () => {
		const state = applyWorkspaceChatEvents(
			initialWorkspaceChatState("c1"),
			turn,
		);
		expect(state.turns).toHaveLength(1);
		const [row] = state.turns;
		expect(row?.text).toBe("How many challenges are open?");
		expect(
			row?.steps.map((step) => [step.label, step.status, step.summary]),
		).toEqual([["Reading Challenges sheet", "ok", "12 rows"]]);
		expect(row?.reply).toBe("Twelve are open.");
		expect(row?.replyDone).toBe(true);
		expect(row?.status).toBe("done");
		expect(row?.usage?.costCents).toBe(2);
		expect(state.cursor).toBe(7);
		expect(state.lastEventAt).toBe(Date.parse(at(4)));
		expect(activeTurn(state)).toBeNull();
	});

	it("ignores a seq it already folded, so a replay after a drop changes nothing", () => {
		const once = applyWorkspaceChatEvents(
			initialWorkspaceChatState("c1"),
			turn,
		);
		const twice = applyWorkspaceChatEvents(once, turn.slice(2));
		expect(twice.turns[0]?.reply).toBe("Twelve are open.");
		expect(twice.turns[0]?.steps).toHaveLength(1);
	});

	it("keeps streaming prose growing and marks the turn active until it finishes", () => {
		const state = applyWorkspaceChatEvents(
			initialWorkspaceChatState("c1"),
			turn.slice(0, 5),
		);
		expect(state.turns[0]?.reply).toBe("Twelve are open.");
		expect(state.turns[0]?.replyDone).toBe(false);
		expect(activeTurn(state)?.turnId).toBe("t1");
	});

	it("clears the pending send once the object echoes the same text", () => {
		const pending = markPendingSend(initialWorkspaceChatState("c1"), {
			clientTurnId: "x",
			text: "How many challenges are open?",
			sentAt: 1,
		});
		expect(pending.pendingSend).not.toBeNull();
		const echoed = applyWorkspaceChatEvent(pending, turn[0]!);
		expect(echoed.pendingSend).toBeNull();
	});

	it("tracks an approval from request to decision", () => {
		const base = applyWorkspaceChatEvents(
			initialWorkspaceChatState("c1"),
			turn.slice(0, 2),
		);
		const asked = applyWorkspaceChatEvent(base, {
			seq: 10,
			at: at(5),
			conversationId: "c1",
			type: "approval.requested",
			turnId: "t1",
			stepId: "s2",
			approvalId: "a1",
			title: "Write to the sheet",
			reason: "Policy requires a person.",
			target: { id: "sheet-1", title: "Challenges" },
		});
		expect(pendingApproval(activeTurn(asked))?.approvalId).toBe("a1");
		expect(pendingApproval(activeTurn(asked))?.target).toEqual({
			id: "sheet-1",
			title: "Challenges",
		});
		const decided = applyWorkspaceChatEvent(asked, {
			seq: 11,
			at: at(6),
			conversationId: "c1",
			type: "approval.decided",
			approvalId: "a1",
			decision: "approve",
			by: "person:aaron",
		});
		expect(pendingApproval(activeTurn(decided))).toBeNull();
		expect(decided.turns).toHaveLength(1);
		expect(decided.turns[0]?.approvals[0]?.decision).toBe("approve");
	});

	it.each(["approve", "deny"] as const)(
		"replays a %s decision before an older approval page without a phantom turn",
		(decision) => {
			const decided: WorkspaceChatLedgerEvent = {
				seq: 11,
				at: at(6),
				conversationId: "c1",
				type: "approval.decided",
				approvalId: "a1",
				decision,
				by: "person:aaron",
			};
			const requested: WorkspaceChatLedgerEvent = {
				seq: 3,
				at: at(2),
				conversationId: "c1",
				type: "approval.requested",
				turnId: "t1",
				stepId: "s2",
				approvalId: "a1",
				title: "Create a document",
				reason: "Review required",
			};
			const events = [turn[0]!, requested, turn[6]!, decided];
			const live = applyWorkspaceChatEvents(
				initialWorkspaceChatState("c1"),
				events,
			);
			const paged = applyWorkspaceChatEvents(initialWorkspaceChatState("c1"), [
				decided,
				...events.slice(0, 3),
			]);
			for (const state of [live, paged]) {
				expect(state.turns).toHaveLength(1);
				expect(state.turns[0]?.approvals[0]?.decision).toBe(decision);
				expect(activeTurn(state)).toBeNull();
			}
		},
	);

	it.each(["applied", "failed"] as const)(
		"retains a %s execution before an older approval request without a phantom turn",
		(status) => {
			const requested: WorkspaceChatLedgerEvent = {
				type: "approval.requested",
				seq: 2,
				at: at(1),
				conversationId: "c1",
				turnId: "t1",
				stepId: "write",
				approvalId: "a1",
				title: "Create document",
				reason: "Review required",
			};
			const decided: WorkspaceChatLedgerEvent = {
				type: "approval.decided",
				seq: 3,
				at: at(2),
				conversationId: "c1",
				approvalId: "a1",
				decision: "approve",
				by: "person",
			};
			const executed: WorkspaceChatLedgerEvent = {
				type: "approval.executed",
				seq: 4,
				at: at(3),
				conversationId: "c1",
				approvalId: "a1",
				status,
				...(status === "failed" ? { error: "Revision conflict" } : {}),
			};
			const approved = applyWorkspaceChatEvents(
				initialWorkspaceChatState("c1"),
				[turn[0]!, requested, decided],
			);
			expect(approved.turns[0]?.approvals[0]?.execution).toBeUndefined();
			const live = applyWorkspaceChatEvent(approved, executed);
			const paged = applyWorkspaceChatEvents(initialWorkspaceChatState("c1"), [
				executed,
				decided,
				turn[0]!,
				requested,
			]);
			for (const state of [live, paged]) {
				expect(state.turns).toHaveLength(1);
				expect(state.turns[0]?.approvals[0]).toMatchObject({
					decision: "approve",
					execution: { status },
				});
				expect(state.turns[0]?.approvals[0]?.execution?.error).toBe(
					status === "failed" ? "Revision conflict" : undefined,
				);
			}
		},
	);

	it("shows the continuation label while preserving its model context on the wire", () => {
		const state = applyWorkspaceChatEvent(initialWorkspaceChatState("c1"), {
			...(turn[0] as Extract<
				WorkspaceChatLedgerEvent,
				{ type: "turn.started" }
			>),
			text: 'Approved by person:aaron; outputs.create applied: {"id":"private-id"}',
			displayText: "Approved the requested action.",
		});
		expect(state.turns[0]?.text).toBe("Approved the requested action.");
	});

	it("drops events of another conversation but still advances the cursor", () => {
		const state = applyWorkspaceChatEvent(initialWorkspaceChatState("c1"), {
			...turn[0]!,
			conversationId: "c2",
			seq: 99,
		});
		expect(state.turns).toHaveLength(0);
		expect(state.cursor).toBe(99);
	});

	it("keeps an unassigned draft empty while workspace replay advances", () => {
		const state = applyWorkspaceChatEvents(
			initialWorkspaceChatState(null),
			turn,
		);
		expect(state.turns).toEqual([]);
		expect(state.cursor).toBe(7);
		expect(state.seen.size).toBe(0);
	});

	it("updates summaries from new turns without replaying older metadata over them", () => {
		const first = turn[0]!;
		const state = applyWorkspaceChatEvents(initialWorkspaceChatState("c1"), [
			first,
			{
				...first,
				seq: 20,
				at: at(20),
				turnId: "t2",
				text: "A follow-up",
			} as WorkspaceChatLedgerEvent,
			{ ...first, seq: 0, at: at(0) },
		]);
		expect(state.conversations).toEqual([
			{
				id: "c1",
				title: "How many challenges are open?",
				updatedAt: at(20),
				lastTurnAt: at(20),
			},
		]);
	});

	it("upserts conversation titles without replacing them with older history", () => {
		const event: WorkspaceChatLedgerEvent = {
			type: "conversation.updated",
			seq: 10,
			at: at(5),
			conversationId: "new",
			title: "New conversation",
		};
		const state = applyWorkspaceChatEvents(initialWorkspaceChatState("c1"), [
			event,
			{ ...event, seq: 1, at: at(0), title: "Old title" },
		]);
		expect(
			state.conversations.map((conversation) => conversation.title),
		).toEqual(["New conversation"]);
		expect(state.seen.size).toBe(0);
	});

	it("assembles earlier delta pages in sequence order after a terminal event", () => {
		const state = applyWorkspaceChatEvents(initialWorkspaceChatState("c1"), [
			turn[6]!,
			turn[4]!,
			turn[0]!,
			turn[3]!,
		]);
		expect(state.turns[0]?.text).toBe("How many challenges are open?");
		expect(state.turns[0]?.reply).toBe("Twelve are open.");
		expect(state.turns[0]?.status).toBe("done");
	});
});

describe("labels", () => {
	it("formats elapsed time and usage plainly", () => {
		expect(elapsedLabel(4_200)).toBe("4s");
		expect(elapsedLabel(125_000)).toBe("2m 05s");
		expect(
			formatUsage({ inputTokens: 2000, outputTokens: 500, costCents: 2 }),
		).toBe("2,000 input · 500 output tokens");
	});
});

it("model and cumulative usage converge when progress arrives after completion", () => {
	const events: WorkspaceChatLedgerEvent[] = [
		{
			type: "turn.model",
			seq: 1,
			at: at(0),
			conversationId: "c1",
			turnId: "t1",
			model: "configured-deployment",
		},
		{
			type: "turn.usage",
			seq: 2,
			at: at(0),
			conversationId: "c1",
			turnId: "t1",
			usage: { inputTokens: 10, outputTokens: 2 },
		},
		{
			type: "assistant.done",
			seq: 3,
			at: at(0),
			conversationId: "c1",
			turnId: "t1",
			messageId: "m1",
			text: "Done",
			model: "provider-snapshot",
			usage: { inputTokens: 20, outputTokens: 4, partial: true },
		},
	];
	for (const order of [events, [...events].reverse()]) {
		const state = applyWorkspaceChatEvents(
			initialWorkspaceChatState("c1"),
			order,
		);
		expect(state.turns[0]?.model).toBe("provider-snapshot");
		expect(state.turns[0]?.usage).toEqual({
			inputTokens: 20,
			outputTokens: 4,
			partial: true,
		});
	}
	expect(
		formatUsage({
			inputTokens: 20,
			outputTokens: 4,
			cachedInputTokens: 10,
			partial: true,
			costCents: 100,
		}),
	).toBe("20 input · 4 output tokens · 10 cached input · partial usage");
});
