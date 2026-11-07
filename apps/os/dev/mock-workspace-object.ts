#!/usr/bin/env bun
/**
 * A local stand-in for a workspace object's chat lane.
 *
 * Speaks the wire format in `src/lib/workspace-chat-protocol.ts`: subscribe
 * with a cursor, replay from the ledger, stream tokens and steps for a turn,
 * raise an approval when the question would write or send something. State is
 * in memory and per workspace id. Start it next to `bun run-local`:
 *
 *   bun run --cwd apps/os dev:workspace-mock
 *
 * The OS worker forwards `/workspace/{id}/chat` here when
 * `WORKSPACE_OBJECT_URL` is set (the local lane sets it to this port).
 */

import type { ServerWebSocket } from "bun";
import type {
	ConversationSummary,
	WorkspaceChatClientMessage,
	WorkspaceChatLedgerEvent,
	WorkspaceChatServerMessage,
} from "../src/lib/workspace-chat-protocol";

const PORT = Number(process.env.WORKSPACE_MOCK_PORT ?? 8793);
/** Milliseconds between streamed tokens; `0` for a burst. */
const TOKEN_GAP_MS = Number(process.env.WORKSPACE_MOCK_TOKEN_GAP_MS ?? 35);

type Socket = ServerWebSocket<{
	workspaceId: string;
	conversationId: string | null;
}>;

type Workspace = {
	seq: number;
	ledger: WorkspaceChatLedgerEvent[];
	conversations: Map<string, ConversationSummary>;
	sockets: Set<Socket>;
	pendingApprovals: Map<
		string,
		{
			turnId: string;
			conversationId: string;
			resume: () => void;
			end: () => void;
		}
	>;
	cancelled: Set<string>;
};

const workspaces = new Map<string, Workspace>();

function workspace(id: string): Workspace {
	let found = workspaces.get(id);
	if (!found) {
		found = {
			seq: 0,
			ledger: [],
			conversations: new Map(),
			sockets: new Set(),
			pendingApprovals: new Map(),
			cancelled: new Set(),
		};
		workspaces.set(id, found);
	}
	return found;
}

function sendTo(socket: Socket, message: WorkspaceChatServerMessage): void {
	if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

type Unstamped<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;

function emit(
	ws: Workspace,
	event: Unstamped<WorkspaceChatLedgerEvent>,
): WorkspaceChatLedgerEvent {
	ws.seq += 1;
	const stamped = {
		...event,
		seq: ws.seq,
		at: new Date().toISOString(),
	} as WorkspaceChatLedgerEvent;
	ws.ledger.push(stamped);
	const conversation = ws.conversations.get(stamped.conversationId);
	if (conversation) {
		conversation.updatedAt = stamped.at;
		if (stamped.type === "turn.started") conversation.lastTurnAt = stamped.at;
	}
	for (const socket of ws.sockets) {
		if (
			socket.data.conversationId === null ||
			socket.data.conversationId === stamped.conversationId ||
			stamped.type === "conversation.updated"
		)
			sendTo(socket, stamped);
	}
	return stamped;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function planSteps(text: string): Array<{
	label: string;
	kind: "read" | "write" | "code" | "tool" | "think";
	ms: number;
	summary: string;
}> {
	const lower = text.toLowerCase();
	const steps = [
		{
			label: "Reading Challenges sheet",
			kind: "read" as const,
			ms: 450,
			summary: "12 rows",
		},
	];
	if (lower.includes("work") || lower.includes("task"))
		steps.push({
			label: "Listing Work",
			kind: "read",
			ms: 380,
			summary: "4 open items",
		});
	if (
		lower.includes("count") ||
		lower.includes("how many") ||
		lower.includes("sum")
	)
		steps.push({
			label: "Running code",
			kind: "code",
			ms: 600,
			summary: "ok",
		});
	return steps;
}

function needsApproval(text: string): string | null {
	const lower = text.toLowerCase();
	if (lower.includes("send") || lower.includes("email"))
		return "Send an email from the workspace mailbox";
	if (lower.includes("delete") || lower.includes("remove"))
		return "Delete rows in the Challenges sheet";
	if (lower.includes("write") || lower.includes("update"))
		return "Write to the Challenges sheet";
	return null;
}

function reply(text: string): string {
	return [
		`Here is what I found for "${text.trim()}".`,
		"",
		"The Challenges sheet lists **12 open challenges**; three are overdue and two are waiting on a reply from the partner team.",
		"",
		"- Energy storage pilot: due 14 Nov, owner Maya",
		"- Grid interconnect review: due 21 Nov, owner Koral",
		"- Supplier onboarding: overdue by 6 days",
		"",
		"Want me to draft a status note for the overdue ones?",
	].join("\n");
}

async function runTurn(
	ws: Workspace,
	conversationId: string,
	turnId: string,
	text: string,
	authorId: string,
): Promise<void> {
	const started = Date.now();
	const finish = (status: "done" | "error" | "cancelled", error?: string) =>
		emit(ws, {
			type: "turn.finished",
			conversationId,
			turnId,
			status,
			error,
			durationMs: Date.now() - started,
		});
	emit(ws, {
		type: "turn.started",
		conversationId,
		turnId,
		text,
		authorId,
		authorKind: "person",
	});
	for (const [index, step] of planSteps(text).entries()) {
		if (ws.cancelled.has(turnId)) return void finish("cancelled");
		const stepId = `${turnId}-s${index + 1}`;
		emit(ws, {
			type: "step.started",
			conversationId,
			turnId,
			stepId,
			label: step.label,
			kind: step.kind,
		});
		await sleep(step.ms);
		emit(ws, {
			type: "step.finished",
			conversationId,
			turnId,
			stepId,
			status: "ok",
			summary: step.summary,
			durationMs: step.ms,
		});
	}
	const approvalTitle = needsApproval(text);
	if (approvalTitle) {
		const stepId = `${turnId}-approval`;
		const approvalId = `${turnId}-a1`;
		emit(ws, {
			type: "step.started",
			conversationId,
			turnId,
			stepId,
			label: approvalTitle,
			kind: "write",
		});
		emit(ws, {
			type: "approval.requested",
			conversationId,
			turnId,
			stepId,
			approvalId,
			title: approvalTitle,
			reason: "The workspace policy requires a person to approve this change.",
			policy: "compliance:needs_approval",
			input: { action: approvalTitle, rows: 3 },
		});
		const decision = await new Promise<"approve" | "deny">((resolve) => {
			ws.pendingApprovals.set(approvalId, {
				turnId,
				conversationId,
				resume: () => resolve("approve"),
				end: () => resolve("deny"),
			});
		});
		ws.pendingApprovals.delete(approvalId);
		emit(ws, {
			type: "step.finished",
			conversationId,
			turnId,
			stepId,
			status: decision === "approve" ? "ok" : "error",
			summary: decision === "approve" ? "done" : "not approved",
			durationMs: 120,
			error: decision === "approve" ? undefined : "Denied by the approver",
		});
		if (decision === "deny") {
			const messageId = `${turnId}-m1`;
			const text = "Understood, I left the sheet unchanged.";
			emit(ws, {
				type: "assistant.delta",
				conversationId,
				turnId,
				messageId,
				text,
			});
			emit(ws, {
				type: "assistant.done",
				conversationId,
				turnId,
				messageId,
				text,
				usage: { inputTokens: 1_200, outputTokens: 12, costCents: 1 },
				model: "mock",
			});
			return void finish("done");
		}
	}
	const messageId = `${turnId}-m1`;
	const full = reply(text);
	let sent = "";
	for (const token of full.match(/\S+\s*|\n/g) ?? []) {
		if (ws.cancelled.has(turnId)) return void finish("cancelled");
		sent += token;
		emit(ws, {
			type: "assistant.delta",
			conversationId,
			turnId,
			messageId,
			text: token,
		});
		if (TOKEN_GAP_MS > 0) await sleep(TOKEN_GAP_MS);
	}
	emit(ws, {
		type: "assistant.done",
		conversationId,
		turnId,
		messageId,
		text: sent,
		usage: {
			inputTokens: 2_480,
			outputTokens: 96,
			cachedInputTokens: 1_900,
			costCents: 2,
		},
		model: "mock",
	});
	finish("done");
}

function handle(socket: Socket, raw: string | Buffer): void {
	let message: WorkspaceChatClientMessage;
	try {
		message = JSON.parse(String(raw)) as WorkspaceChatClientMessage;
	} catch {
		return;
	}
	const ws = workspace(socket.data.workspaceId);
	switch (message.type) {
		case "subscribe": {
			socket.data.conversationId = message.conversationId;
			sendTo(socket, {
				type: "hello",
				cursor: ws.seq,
				serverTime: new Date().toISOString(),
				conversations: [...ws.conversations.values()].sort((a, b) =>
					b.updatedAt.localeCompare(a.updatedAt),
				),
			});
			const cursor = message.cursor;
			const relevant = ws.ledger.filter(
				(event) =>
					message.conversationId === null ||
					event.conversationId === message.conversationId,
			);
			const replay =
				cursor === null
					? recentTurns(relevant, 20)
					: relevant.filter((event) => event.seq > cursor);
			for (const event of replay) sendTo(socket, event);
			sendTo(socket, {
				type: "caught_up",
				conversationId: message.conversationId,
			});
			return;
		}
		case "send_turn": {
			const conversationId =
				message.conversationId ?? `conv-${crypto.randomUUID().slice(0, 8)}`;
			if (!ws.conversations.has(conversationId)) {
				ws.conversations.set(conversationId, {
					id: conversationId,
					title: message.text.slice(0, 60),
					updatedAt: new Date().toISOString(),
					lastTurnAt: null,
				});
				socket.data.conversationId = conversationId;
				emit(ws, {
					type: "conversation.updated",
					conversationId,
					title: message.text.slice(0, 60),
				});
			}
			const turnId = `turn-${crypto.randomUUID().slice(0, 8)}`;
			sendTo(socket, {
				type: "turn.accepted",
				clientTurnId: message.clientTurnId,
				turnId,
				conversationId,
			});
			void runTurn(ws, conversationId, turnId, message.text, "person:local");
			return;
		}
		case "decide_approval": {
			const pending = ws.pendingApprovals.get(message.approvalId);
			if (!pending) return;
			emit(ws, {
				type: "approval.decided",
				conversationId: pending.conversationId,
				turnId: pending.turnId,
				approvalId: message.approvalId,
				decision: message.decision,
				by: "person:local",
			});
			if (message.decision === "approve") pending.resume();
			else pending.end();
			return;
		}
		case "cancel_turn":
			ws.cancelled.add(message.turnId);
			return;
		case "read_ledger": {
			const older = ws.ledger.filter(
				(event) =>
					event.conversationId === message.conversationId &&
					event.seq < message.before,
			);
			const page = recentTurns(
				older,
				Math.max(1, Math.floor(message.limit / 8)),
			);
			sendTo(socket, {
				type: "ledger.page",
				conversationId: message.conversationId,
				events: page,
				hasMore: page.length > 0 && page[0]!.seq > (older[0]?.seq ?? 0),
			});
			return;
		}
		case "ping":
			sendTo(socket, { type: "pong" });
			return;
	}
}

/** The events of the last `count` turns, in ledger order. */
function recentTurns(
	events: WorkspaceChatLedgerEvent[],
	count: number,
): WorkspaceChatLedgerEvent[] {
	const starts = events.filter((event) => event.type === "turn.started");
	const cut = starts.at(-count);
	if (!cut) return events;
	return events.filter((event) => event.seq >= cut.seq);
}

Bun.serve<Socket["data"]>({
	port: PORT,
	fetch(request, server) {
		const url = new URL(request.url);
		const match = /^\/workspace\/([^/]+)\/chat$/.exec(url.pathname);
		if (!match)
			return new Response(
				url.pathname === "/health"
					? "ok\n"
					: "mock workspace object: open /workspace/{id}/chat as a WebSocket\n",
				{ status: url.pathname === "/health" ? 200 : 404 },
			);
		const workspaceId = decodeURIComponent(match[1]!);
		if (
			server.upgrade(request, {
				data: { workspaceId, conversationId: null },
			})
		)
			return undefined;
		return new Response("Expected a WebSocket upgrade.\n", { status: 426 });
	},
	websocket: {
		open(socket) {
			workspace(socket.data.workspaceId).sockets.add(socket);
		},
		message(socket, raw) {
			handle(socket, raw);
		},
		close(socket) {
			workspace(socket.data.workspaceId).sockets.delete(socket);
		},
	},
});

console.log(
	`mock workspace object on http://localhost:${PORT} (ws /workspace/{id}/chat, token gap ${TOKEN_GAP_MS} ms)`,
);
