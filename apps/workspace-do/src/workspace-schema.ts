import { ACTIVITY_SCHEMA } from "./activity-records";
import { LEDGER_SCHEMA } from "./adapters";
import { EVENT_LEDGER_SCHEMA } from "./event-ledger";
import { MEMORY_SCHEMA } from "./memory-adapter";
import { PERSON_CHATS_SCHEMA } from "./person-chats";
import type { WorkspaceStorage } from "./runtime";
import { STAGED_SCHEMA } from "./staged-changes";
import { WEB_SCHEMA } from "./web";

/** WorkspaceDO-owned tables, separate from TenantStore's generated chain. */
export const WORKSPACE_SCHEMA_VERSION = 1;

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY,
	title TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_turn_at TEXT,
	archived_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	at TEXT NOT NULL,
	message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS turns (
	turn_id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	tedi_id TEXT,
	text TEXT,
	error TEXT,
	first_seq INTEGER
);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id);
CREATE TABLE IF NOT EXISTS approvals (
	approval_id TEXT PRIMARY KEY,
	turn_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	step_id TEXT NOT NULL,
	binding TEXT NOT NULL,
	method TEXT NOT NULL,
	args TEXT NOT NULL,
	resource TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	tedi_id TEXT,
	status TEXT NOT NULL,
	decided_by TEXT,
	decided_at TEXT,
	action_class TEXT
);
CREATE TABLE IF NOT EXISTS queued_messages (
	message_id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	at TEXT NOT NULL,
	status TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	model_text TEXT NOT NULL,
	request TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queued_messages_waiting ON queued_messages(conversation_id, status);
`;

export function readWorkspaceSchemaVersion(storage: WorkspaceStorage): {
	version: number;
	appliedAt: string | null;
} {
	const [row] = storage.exec<{ version: number; applied_at: string }>(
		"SELECT version, applied_at FROM workspace_schema_version WHERE slot = 1",
	);
	return { version: row?.version ?? 0, appliedAt: row?.applied_at ?? null };
}

/** Call inside storage.transactionSync so a failed upgrade never advances the version. */
export function migrateWorkspaceSchema(storage: WorkspaceStorage): void {
	storage.run(`CREATE TABLE IF NOT EXISTS workspace_schema_version (
		slot INTEGER PRIMARY KEY CHECK (slot = 1),
		version INTEGER NOT NULL,
		applied_at TEXT NOT NULL
	)`);
	const { version } = readWorkspaceSchemaVersion(storage);
	if (version > WORKSPACE_SCHEMA_VERSION)
		throw new Error("Workspace schema is newer than this Worker");
	if (version === WORKSPACE_SCHEMA_VERSION) return;

	storage.run(CHAT_SCHEMA);
	storage.run(WEB_SCHEMA);
	storage.run(PERSON_CHATS_SCHEMA);
	storage.run(EVENT_LEDGER_SCHEMA);
	storage.run(LEDGER_SCHEMA);
	storage.run(STAGED_SCHEMA);
	storage.run(MEMORY_SCHEMA);
	storage.run(ACTIVITY_SCHEMA);
	// Version-zero stores may predate approval modes and ledger seals.
	// Retire this upgrade only after the complete live namespace sweep reaches v1.
	storage.delete("auto-approval-rules");
	for (const [table, column] of [
		["approvals", "action_class"],
		["change_records", "record_digest"],
		["change_records", "chain_hash"],
	] as const) {
		if (
			!storage
				.exec<{ name: string }>(`PRAGMA table_info(${table})`)
				.some((entry) => entry.name === column)
		)
			storage.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
	}
	storage.run(
		"INSERT OR REPLACE INTO workspace_schema_version (slot, version, applied_at) VALUES (1, ?, ?)",
		WORKSPACE_SCHEMA_VERSION,
		new Date().toISOString(),
	);
}
