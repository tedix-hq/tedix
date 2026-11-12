import type { WorkspaceUnreadFeedRow } from "@tedix/db/queries/workspace-unread";
import { describe, expect, it } from "vite-plus/test";
import { advanceReadMarker, unreadFromFeed } from "./workspace-unread";

function run(
	seq: number,
	operation: string,
	extra: Partial<WorkspaceUnreadFeedRow> & { outcome?: string } = {},
): WorkspaceUnreadFeedRow {
	const { outcome, ...row } = extra;
	return {
		seq,
		kind: "run",
		entityId: `turn-${seq}`,
		actorKind: "user",
		actorId: "person-b",
		title: null,
		occurredAt: `2026-11-12T10:00:${String(seq).padStart(2, "0")}.000Z`,
		runSummary: JSON.stringify({
			conversationId: "chat-1",
			action: {
				resource: "conversation",
				operation,
				outcome: outcome ?? "applied",
				surface: "workspace_object",
				traceId: `turn-${seq}`,
			},
		}),
		...row,
	};
}
function file(seq: number, outputId: string): WorkspaceUnreadFeedRow {
	return {
		seq,
		kind: "output",
		entityId: outputId,
		actorKind: "user",
		actorId: "person-b",
		title: `File ${outputId}`,
		occurredAt: "2026-11-12T10:00:00.000Z",
		runSummary: null,
	};
}

describe("unreadFromFeed", () => {
	it("counts another person's message, an agent's result and a question, and ignores steps", () => {
		const unread = unreadFromFeed(
			[
				run(9, "approval.requested", { actorKind: "tedi" }),
				run(8, "turn.finished", { actorKind: "tedi", outcome: "not_applied" }),
				run(7, "turn.finished", { actorKind: "tedi" }),
				run(6, "step.finished", { actorKind: "tedi" }),
				run(5, "turn.started"),
				run(4, "turn.started", { actorKind: "tedi" }),
			],
			{ floor: 0, chat: 0, chats: {}, files: {} },
		);
		expect(unread.chat.map((item) => [item.kind, item.byAgent])).toEqual([
			["needs_decision", true],
			["agent_stopped", true],
			["agent_reply", true],
			["message", false],
		]);
		expect(unread.chat[3]).toMatchObject({
			conversationId: "chat-1",
			turnId: "turn-5",
		});
	});

	it("keeps chat and each file read separately above the floor", () => {
		const rows = [
			file(8, "b"),
			run(7, "turn.started"),
			file(6, "a"),
			file(5, "a"),
		];
		expect(
			unreadFromFeed(rows, { floor: 4, chat: 7, chats: {}, files: { a: 6 } }),
		).toMatchObject({ chat: [], files: [{ outputId: "b", id: "8" }] });
		const all = unreadFromFeed(rows, {
			floor: 4,
			chat: 4,
			chats: {},
			files: {},
		});
		expect(all.chat).toHaveLength(1);
		// One entry per file, at its newest change.
		expect(all.files.map((item) => [item.outputId, item.id])).toEqual([
			["b", "8"],
			["a", "6"],
		]);
	});

	it("ignores rows without readable chat metadata", () => {
		expect(
			unreadFromFeed(
				[
					{ ...run(3, "turn.started"), runSummary: "{" },
					{ ...run(2, "turn.started"), runSummary: null },
					{
						...run(1, "turn.started"),
						runSummary: JSON.stringify({
							action: {
								resource: "outputs",
								operation: "archive",
								outcome: "applied",
								surface: "workspace_object",
							},
						}),
					},
				],
				{ floor: 0, chat: 0, chats: {}, files: {} },
			),
		).toEqual({ chat: [], files: [] });
	});
});

describe("advanceReadMarker", () => {
	it("starts a first visit at the current position so older history is never unread", () => {
		expect(advanceReadMarker(null, { type: "chat" }, 40)).toEqual({
			floor: 40,
			chat: 40,
			chats: {},
			files: {},
		});
	});
	it("marks one conversation read, with the rows that name none, and leaves the others", () => {
		const marker = advanceReadMarker(
			{ floor: 0, chat: 0, chats: {}, files: {} },
			{ type: "chat", conversationId: "chat-1" },
			6,
		);
		expect(marker.chats).toEqual({ "chat-1": 6, "": 6 });
		const other = {
			...run(5, "turn.started"),
			runSummary: run(5, "turn.started").runSummary!.replace(
				"chat-1",
				"chat-2",
			),
		};
		expect(
			unreadFromFeed(
				[run(7, "turn.started"), other, run(4, "turn.started")],
				marker,
			).chat.map((item) => item.id),
		).toEqual(["7", "5"]);
	});
	it("leaves an existing marker alone when the person only opens the workspace", () => {
		const marker = { floor: 10, chat: 30, chats: {}, files: { a: 20 } };
		expect(advanceReadMarker(marker, { type: "visit" }, 99)).toBe(marker);
		expect(advanceReadMarker(null, { type: "visit" }, 99).floor).toBe(99);
	});
	it("moves only what the person looked at, and never backwards", () => {
		const marker = { floor: 10, chat: 30, chats: {}, files: { a: 20 } };
		expect(advanceReadMarker(marker, { type: "chat" }, 25).chat).toBe(30);
		expect(
			advanceReadMarker(marker, { type: "file", outputId: "b" }, 35),
		).toEqual({ floor: 10, chat: 30, chats: {}, files: { a: 20, b: 35 } });
		expect(advanceReadMarker(marker, { type: "all" }, 35)).toEqual({
			floor: 35,
			chat: 35,
			chats: {},
			files: {},
		});
	});
});
