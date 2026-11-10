import type { WorkspaceScope } from "./env";
import type { WorkspaceStorage } from "./runtime";
import type { WireEventBody } from "./wire";

interface MovedEvent {
	id: string;
	conversation_id: string;
	run_id: string | null;
	message_id: string | null;
	kind: string;
	payload: string | null;
	created_at: string;
}

/** Import-time conversion; chat readers only use the native tables afterwards. */
export function migrateMovedChat(
	store: WorkspaceStorage,
	scope: WorkspaceScope,
) {
	store.run(
		`INSERT INTO conversations (id, title, created_at, updated_at, last_turn_at, archived_at)
		SELECT conversation_id, title, created_at, updated_at, last_message_at, coalesce(deleted_at, archived_at)
		FROM kernel_conversations WHERE organization_id = ? AND workspace_id = ?
		ON CONFLICT(id) DO NOTHING`,
		scope.organizationId,
		scope.workspaceId,
	);
	store.run(
		`INSERT INTO turns (turn_id, conversation_id, started_at, finished_at, status, actor_id, actor_kind, text, error)
		SELECT r.id, r.conversation_id, coalesce(r.started_at, r.created_at), r.completed_at,
		CASE WHEN r.status = 'completed' THEN 'finished' ELSE 'failed' END,
		'workspace_import', 'service', NULL,
		CASE WHEN r.status = 'completed' THEN NULL ELSE 'Imported run: ' || r.status END
		FROM kernel_runtime_runs r JOIN kernel_conversations c ON c.conversation_id = r.conversation_id AND c.organization_id = r.organization_id
		WHERE c.organization_id = ? AND c.workspace_id = ?
		ON CONFLICT(turn_id) DO NOTHING`,
		scope.organizationId,
		scope.workspaceId,
	);
	const events = store.exec<MovedEvent>(
		`SELECT e.id, e.conversation_id, coalesce(e.run_id, r.id) AS run_id,
		e.message_id, e.kind, e.payload, e.created_at
		FROM kernel_runtime_events e
		JOIN kernel_conversations c ON c.organization_id = e.organization_id AND c.conversation_id = e.conversation_id
		LEFT JOIN kernel_runtime_runs r ON r.organization_id = e.organization_id AND r.conversation_id = e.conversation_id AND r.input_message_id = e.message_id AND e.run_id IS NULL
		WHERE c.organization_id = ? AND c.workspace_id = ?
		AND e.kind IN ('message.received', 'message.completed', 'run.completed', 'run.failed', 'run.cancelled')
		ORDER BY e.created_at, CASE e.kind WHEN 'message.received' THEN 0 WHEN 'message.completed' THEN 1 ELSE 2 END, e.id`,
		scope.organizationId,
		scope.workspaceId,
	);
	for (const event of events) {
		const key = `moved-chat-event:${event.id}`;
		if (store.get(key)) continue;
		const payload = (JSON.parse(event.payload ?? "{}") ?? {}) as Record<
			string,
			unknown
		>;
		const turnId = event.run_id ?? event.id;
		const text = typeof payload.content === "string" ? payload.content : "";
		let body: WireEventBody;
		if (event.kind === "message.received") {
			body = {
				type: "turn.started",
				turnId,
				text,
				authorId: "workspace_import",
				authorKind: "person",
			};
		} else if (event.kind === "message.completed") {
			if (payload.role && payload.role !== "assistant") continue;
			body = {
				type: "assistant.done",
				turnId,
				messageId: event.message_id ?? event.id,
				text,
			};
		} else {
			const [turn] = store.exec<{ started_at: string }>(
				"SELECT started_at FROM turns WHERE turn_id = ?",
				turnId,
			);
			const error =
				typeof payload.error === "string"
					? payload.error
					: typeof payload.status === "string" && payload.status !== "completed"
						? `Imported run: ${payload.status}`
						: undefined;
			body = {
				type: "turn.finished",
				turnId,
				status:
					event.kind === "run.cancelled"
						? "cancelled"
						: event.kind === "run.failed" || error
							? "error"
							: "done",
				durationMs: turn
					? Math.max(
							0,
							Date.parse(event.created_at) - Date.parse(turn.started_at),
						)
					: 0,
				...(error ? { error } : {}),
			};
		}
		const [inserted] = store.exec<{ seq: number }>(
			"INSERT INTO events (conversation_id, turn_id, at, type, body) VALUES (?, ?, ?, ?, ?) RETURNING seq",
			event.conversation_id,
			turnId,
			event.created_at,
			body.type,
			JSON.stringify(body),
		);
		if (body.type === "turn.started") {
			store.run(
				`INSERT INTO turns (turn_id, conversation_id, started_at, status, actor_id, actor_kind, error, first_seq)
				VALUES (?, ?, ?, 'failed', 'workspace_import', 'service', 'Imported run has no terminal receipt', ?)
				ON CONFLICT(turn_id) DO UPDATE SET first_seq = coalesce(turns.first_seq, excluded.first_seq)`,
				turnId,
				event.conversation_id,
				event.created_at,
				inserted!.seq,
			);
		}
		if (body.type === "assistant.done")
			store.run("UPDATE turns SET text = ? WHERE turn_id = ?", text, turnId);
		if (body.type === "turn.finished")
			store.run(
				"UPDATE turns SET status = ?, finished_at = ?, error = ? WHERE turn_id = ?",
				body.status === "done" ? "finished" : "failed",
				event.created_at,
				body.error ?? (body.status === "cancelled" ? "cancelled" : null),
				turnId,
			);
		if (body.type === "turn.started" || body.type === "assistant.done") {
			// User-role context preserves imported text without inventing model or usage receipts.
			const content =
				body.type === "assistant.done"
					? `Previous assistant response:\n${text}`
					: text;
			store.run(
				"INSERT INTO messages (conversation_id, turn_id, at, message) VALUES (?, ?, ?, ?)",
				event.conversation_id,
				turnId,
				event.created_at,
				JSON.stringify({
					role: "user",
					content,
					timestamp: Date.parse(event.created_at),
				}),
			);
		}
		store.put(key, true);
	}
}
