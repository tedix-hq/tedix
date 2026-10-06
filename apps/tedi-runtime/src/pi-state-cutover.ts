/** Temporary, explicitly invoked storage cutover engine. No Agent lifecycle or recovery. */
import { openPiSessionStore } from "agents/harness/pi";
import {
	Harness,
	createSession,
	createRegistry,
	type Cursor,
	type EntryRecord,
	type ConversationId,
} from "@earendil-works/pi-durable";
import { createModels, type Message } from "@earendil-works/pi-ai";
import type { SessionMessage } from "agents/sessions";

const CONTEXT = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "tedix-state-cutover",
};
const PAGE_SIZE = 100;
export interface CutoverOwner {
	tediId: string;
	orgId: string;
}
export interface CutoverMessage {
	id: string;
	original: SessionMessage;
	display: SessionMessage;
	model: Message[];
	/** Exact validated descriptor projections; used for immutable ownership/input hashing. */
	privateImages?: readonly Record<string, unknown>[];
}
export interface CutoverReceipt {
	id: string;
	source: string;
	status: string;
	terminal: boolean;
	sha256?: string;
}
export interface CutoverInventory {
	/** Stored identity projection only; unknown never authorizes an inferred owner. */
	storedOwner: {
		tediId: string | null;
		orgId: string | null;
		slug: string | null;
		sessionKey: string | null;
		unknown: boolean;
	};
	tables: { name: string; rows: number }[];
	imported: boolean;
	activeConversationId: number | null;
	receipts: CutoverReceipt[];
	privateImages: {
		key: string;
		tediId: string | null;
		orgId: string | null;
		scheme: string | null;
		sha256: string;
	}[];
	children: {
		className: string;
		name: string;
		identityVersion: string | null;
		identityName: string | null;
	}[];
	maintenance: {
		taskId: string;
		scheduleId: string | null;
		nextRunAt: number | null;
	}[];
	blocked: boolean;
}
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function field(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
export async function cutoverHash(value: unknown): Promise<string> {
	const json = JSON.stringify(value);
	if (json === undefined)
		throw new Error("Cutover input is not JSON serializable");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(json),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
function storedOwnerMetadata(
	storage: DurableObjectStorage,
	names: Set<string>,
): CutoverInventory["storedOwner"] {
	const unknown = {
		tediId: null,
		orgId: null,
		slug: null,
		sessionKey: null,
		unknown: true,
	};
	if (!names.has("cf_agents_state")) return unknown;
	const columns = new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM pragma_table_info('cf_agents_state')",
			)
			.toArray()
			.map((row) => row.name),
	);
	if (!columns.has("id") || !columns.has("state")) return unknown;
	// JSON projection in SQLite avoids returning the State payload, even for large rows.
	const keys = ["tediId", "orgId", "slug", "sessionKey"] as const;
	const row = storage.sql
		.exec<Record<string, string | number | null>>(
			`SELECT
		CASE WHEN json_valid(state) THEN json_type(state) ELSE NULL END AS shape,
		${keys
			.map(
				(
					key,
				) => `CASE WHEN json_valid(state) THEN json_type(state, '$.${key}') ELSE NULL END AS ${key}Type,
		CASE WHEN json_valid(state) THEN CASE WHEN json_type(state, '$.${key}') = 'text' AND length(json_extract(state, '$.${key}')) <= 256 THEN json_extract(state, '$.${key}') ELSE NULL END ELSE NULL END AS ${key}`,
			)
			.join(",")}
		FROM cf_agents_state WHERE id = ? LIMIT 1`,
			"cf_state_row_id",
		)
		.toArray()[0];
	if (
		!row ||
		row.shape !== "object" ||
		keys.some(
			(key) =>
				![null, "null", "text"].includes(row[`${key}Type`] as string | null) ||
				(row[`${key}Type`] === "text" && row[key] === null),
		)
	)
		return unknown;
	const tediId = field(row.tediId),
		orgId = field(row.orgId);
	return {
		tediId,
		orgId,
		slug: field(row.slug),
		sessionKey: field(row.sessionKey),
		unknown: !tediId || !orgId,
	};
}
async function* storedPrefix(
	storage: Pick<DurableObjectStorage, "list">,
	prefix: string,
) {
	let startAfter: string | undefined;
	for (;;) {
		const rows = await storage.list<unknown>({
			prefix,
			limit: PAGE_SIZE,
			...(startAfter ? { startAfter } : {}),
		});
		for (const row of rows) {
			startAfter = row[0];
			yield row;
		}
		if (rows.size < PAGE_SIZE) return;
	}
}
/** Reads only metadata/hashes. Never settles, deletes, redrives, or reveals receipt payloads. */
export async function inventoryPiStateCutover(
	storage: DurableObjectStorage,
): Promise<CutoverInventory> {
	const names = new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.toArray()
			.map((row) => row.name),
	);
	const tables: CutoverInventory["tables"] = [];
	const receipts: CutoverReceipt[] = [];
	const known = [
		"cf_think_submissions",
		"cf_agents_fibers",
		"cf_agents_runs",
		"cf_agents_task_runs",
		"cf_think_scheduled_tasks",
		"cf_agents_sub_agents",
		"cf_agents_session_messages",
		"cf_agents_session_message_chunks",
		"cf_agents_session_compactions",
		"cf_agents_session_config",
		"cf_agents_session_attachment_meta",
		"cf_agents_session_attachment_chunks",
		"cf_agents_session_attachment_refs",
	];
	for (const name of known)
		if (names.has(name)) {
			const rows =
				storage.sql
					.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`)
					.toArray()[0]?.count ?? 0;
			tables.push({ name, rows });
		}
	for (const [name, id, state] of [
		["cf_think_submissions", "submission_id", "status"],
		["cf_agents_fibers", "fiber_id", "status"],
		["cf_agents_runs", "id", "completed_at"],
		["cf_agents_task_runs", "run_id", "state"],
	] as const) {
		if (!names.has(name)) continue;
		// An empty receipt table contains no unresolved effect, regardless of its
		// historical schema. Populated unfamiliar schemas remain quarantined.
		if (tables.find((table) => table.name === name)?.rows === 0) continue;
		const columns = new Set(
			storage.sql
				.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`)
				.toArray()
				.map((row) => row.name),
		);
		if (
			![
				id,
				state,
				...(name === "cf_agents_fibers" || name === "cf_agents_runs"
					? ["name"]
					: name === "cf_agents_task_runs"
						? ["definition"]
						: []),
			].every((column) => columns.has(column))
		) {
			receipts.push({
				id: name,
				source: "schema",
				status: "unknown",
				terminal: false,
			});
			continue;
		}
		const hasName = columns.has("name"),
			hasDefinition = columns.has("definition"),
			hasResultStatus = columns.has("result_status");
		const selected = [
			id,
			state,
			...(hasName ? ["name"] : []),
			...(hasDefinition ? ["definition"] : []),
			...(hasResultStatus ? ["result_status"] : []),
		].join(",");
		for (const row of storage.sql
			.exec<Record<string, string | number | null>>(
				`SELECT ${selected} FROM ${name}`,
			)
			.toArray()) {
			if (name !== "cf_think_submissions") {
				const kind = String(row.name ?? row.definition ?? "");
				if (
					!(
						kind === "think:messenger-reply" ||
						kind.startsWith("__cf_internal_chat_turn") ||
						kind === "__cf_internal_messenger_reply" ||
						kind === "__cf_internal_chat_recovery"
					)
				)
					continue;
			}
			const status = String(row[state] ?? "unknown");
			const terminal =
				name === "cf_agents_runs"
					? row[state] !== null
					: name === "cf_think_submissions"
						? ["completed", "aborted", "skipped", "error"].includes(status) &&
							row.result_status !== "retry"
						: name === "cf_agents_fibers"
							? ["completed", "aborted", "error"].includes(status)
							: [
									"completed",
									"aborted",
									"error",
									"failed",
									"cancelled",
									"skipped",
								].includes(status);
			receipts.push({ id: String(row[id]), source: name, status, terminal });
		}
	}
	const pending = await storage.get<unknown>("facet-pending-submission");
	if (pending !== undefined)
		receipts.push({
			id: "facet-pending-submission",
			source: "kv",
			status: "unknown",
			terminal: false,
			sha256: await cutoverHash(pending),
		});
	for (const prefix of [
		"__cf_messenger_recovery:",
		"cf:chat-recovery:incident:",
	])
		for await (const [key, value] of storedPrefix(storage, prefix)) {
			const snapshot = record(value);
			const status = String(
				prefix === "__cf_messenger_recovery:"
					? (snapshot?.stage ?? "unknown")
					: (snapshot?.status ?? "unknown"),
			);
			receipts.push({
				id: key,
				source: "kv",
				status,
				terminal:
					prefix === "__cf_messenger_recovery:"
						? status === "completed"
						: ["completed", "skipped", "exhausted", "failed"].includes(status),
				sha256: await cutoverHash(value),
			});
		}
	const privateImages: CutoverInventory["privateImages"] = [];
	for await (const [key, value] of storedPrefix(
		storage,
		"pi-image-projection:v1:",
	)) {
		const descriptor = record(value);
		let scheme: string | null = null;
		try {
			if (typeof descriptor?.url === "string")
				scheme = new URL(descriptor.url).protocol;
		} catch {
			/* Invalid descriptor stays visible without exposing its URL. */
		}
		privateImages.push({
			key,
			tediId: field(descriptor?.tediId),
			orgId: field(descriptor?.orgId),
			scheme,
			sha256: await cutoverHash(value),
		});
	}
	const children: CutoverInventory["children"] = [];
	if (names.has("cf_agents_sub_agents")) {
		const columns = new Set(
			storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM pragma_table_info('cf_agents_sub_agents')",
				)
				.toArray()
				.map((row) => row.name),
		);
		const optional = ["identity_version", "identity_name"].filter((column) =>
			columns.has(column),
		);
		for (const row of storage.sql
			.exec<Record<string, string | null>>(
				`SELECT class,name${optional.length ? "," + optional.join(",") : ""} FROM cf_agents_sub_agents`,
			)
			.toArray())
			children.push({
				className: String(row.class),
				name: String(row.name),
				identityVersion: field(row.identity_version),
				identityName: field(row.identity_name),
			});
	}
	const maintenance: CutoverInventory["maintenance"] = [];
	if (names.has("cf_think_scheduled_tasks")) {
		const columns = new Set(
			storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM pragma_table_info('cf_think_scheduled_tasks')",
				)
				.toArray()
				.map((row) => row.name),
		);
		if (
			!["task_id", "schedule_id", "next_run_at"].every((column) =>
				columns.has(column),
			)
		)
			receipts.push({
				id: "cf_think_scheduled_tasks",
				source: "schema",
				status: "unknown",
				terminal: false,
			});
		else
			for (const row of storage.sql
				.exec<{
					task_id: string;
					schedule_id: string | null;
					next_run_at: number | null;
				}>(
					"SELECT task_id,schedule_id,next_run_at FROM cf_think_scheduled_tasks",
				)
				.toArray())
				maintenance.push({
					taskId: row.task_id,
					scheduleId: row.schedule_id,
					nextRunAt: row.next_run_at,
				});
	}
	return {
		storedOwner: storedOwnerMetadata(storage, names),
		tables,
		imported: (await storage.get("pi:legacy-imported:v1")) === true,
		activeConversationId:
			(await storage.get<number>("pi-active-conversation-id:v1")) ?? null,
		receipts,
		privateImages,
		children,
		maintenance,
		blocked: receipts.some((receipt) => !receipt.terminal),
	};
}
export interface CutoverImportInput {
	owner: CutoverOwner;
	messages: readonly CutoverMessage[];
	prefix?: string;
	/** Explicit native target; omitted means Pi root conversation 1. */
	conversationId?: number;
}
export interface CutoverImportResult {
	manifestHash: string;
	entries: { messageId: string; entryId: number; sha256: string }[];
}
const importLines = new WeakMap<DurableObjectStorage, Promise<void>>();
/** Passive native writes only. The caller must exclude ordinary writers to this target. */
export async function importPiStateCutover(
	storage: DurableObjectStorage,
	input: CutoverImportInput,
): Promise<CutoverImportResult> {
	const previous = importLines.get(storage) ?? Promise.resolve();
	let release!: () => void;
	const line = new Promise<void>((resolve) => {
		release = resolve;
	});
	importLines.set(storage, line);
	await previous;
	try {
		return await importPiStateCutoverOnLine(storage, input);
	} finally {
		release();
		if (importLines.get(storage) === line) importLines.delete(storage);
	}
}
async function importPiStateCutoverOnLine(
	storage: DurableObjectStorage,
	input: CutoverImportInput,
): Promise<CutoverImportResult> {
	if (
		input.conversationId !== undefined &&
		(!Number.isSafeInteger(input.conversationId) || input.conversationId < 1)
	)
		throw new Error("Cutover requires a positive native conversation ID");
	if (!input.owner.orgId || !input.owner.tediId)
		throw new Error("Cutover requires exact owner identity");
	if (
		new Set(input.messages.map((message) => message.id)).size !==
		input.messages.length
	)
		throw new Error("Cutover message IDs must be unique");
	for (const message of input.messages) {
		if (
			!message.id ||
			message.original.id !== message.id ||
			message.display.id !== message.id ||
			!message.model.length
		)
			throw new Error(
				"Cutover message lacks exact source/display identity or projection",
			);
		for (const image of message.privateImages ?? [])
			if (
				image.orgId !== input.owner.orgId ||
				image.tediId !== input.owner.tediId
			)
				throw new Error("Cutover private image owner mismatch");
	}
	const inventory = await inventoryPiStateCutover(storage);
	if (inventory.blocked)
		throw new Error("Cutover blocked by unresolved persisted receipts");
	const manifestHash = await cutoverHash({
		owner: input.owner,
		messages: input.messages,
		conversationId: input.conversationId ?? 1,
	});
	const namespace = input.prefix ?? "pi_";
	const markerKey = `pi-state-cutover:v1:${namespace}:conversation:${input.conversationId ?? 1}`;
	const prior = await storage.get<
		CutoverImportResult & { owner: CutoverOwner }
	>(markerKey);
	if (
		prior &&
		(prior.manifestHash !== manifestHash ||
			JSON.stringify(prior.owner) !== JSON.stringify(input.owner))
	)
		throw new Error("Cutover manifest changed after admission");
	let nativeStorage = await openPiSessionStore(storage, { prefix: namespace });
	// Store reads never reconcile tasks. Check the entire namespace, not just the target.
	for (const table of ["tasks", "submissions"] as const) {
		let cursor: Cursor | undefined;
		do {
			const page =
				table === "tasks"
					? await nativeStorage.scanTasks({}, PAGE_SIZE, cursor, CONTEXT)
					: await nativeStorage.scanSubmissions({}, PAGE_SIZE, cursor, CONTEXT);
			if (
				page.items.some((row) =>
					"state" in row
						? row.state.status !== "terminal"
						: row.status === "queued" || row.status === "placed",
				)
			) {
				await nativeStorage.close(CONTEXT);
				throw new Error(
					"Cutover blocked by unresolved native tasks or submissions",
				);
			}
			cursor = page.next;
		} while (cursor);
	}
	const targetId = (input.conversationId ?? 1) as ConversationId;
	let target = await nativeStorage.conversation(targetId, CONTEXT);
	if (!target) {
		const conversations = await nativeStorage.scanConversations(
			{},
			1,
			undefined,
			CONTEXT,
		);
		const tasks = await nativeStorage.scanTasks({}, 1, undefined, CONTEXT);
		const submissions = await nativeStorage.scanSubmissions(
			{},
			1,
			undefined,
			CONTEXT,
		);
		const documents = await nativeStorage.scanDocuments(
			{ scope: { kind: "session" }, at: "current" },
			1,
			undefined,
			CONTEXT,
		);
		if (
			targetId !== 1 ||
			conversations.items.length ||
			tasks.items.length ||
			submissions.items.length ||
			documents.items.length
		) {
			await nativeStorage.close(CONTEXT);
			throw new Error("Cutover target conversation does not exist");
		}
	}
	const visible: EntryRecord[] = [];
	if (target) {
		let cursor: Cursor | undefined;
		do {
			const page = await nativeStorage.scanEntries(
				{ conversationId: targetId },
				PAGE_SIZE,
				cursor,
				CONTEXT,
			);
			visible.push(...page.items);
			cursor = page.next;
		} while (cursor);
	}
	// Validate all ancestry and mappings before appending any row.
	const planned = await Promise.all(
		input.messages.map(async (message) => {
			const sha256 = await cutoverHash({
				owner: input.owner,
				original: message.original,
				display: message.display,
				model: message.model,
				privateImages: message.privateImages ?? [],
			});
			const expected = {
				kind: "tedix.legacy-message",
				model: message.model,
				data: { originalId: message.id, originalRole: message.original.role },
			};
			const inherited = visible.filter(
				(entry) =>
					entry.kind === expected.kind &&
					entry.data &&
					typeof entry.data === "object" &&
					!Array.isArray(entry.data) &&
					entry.data.originalId === message.id,
			);
			if (inherited[0]) {
				const sourceMap = await storage.get<{ sha256: string }>(
					`pi-state-cutover:v1:${namespace}:conversation:${inherited[0].conversationId}:message:${encodeURIComponent(message.id)}`,
				);
				if (sourceMap && sourceMap.sha256 !== sha256)
					throw new Error(
						"Cutover inherited source changed after durable import",
					);
				const displayKey = `${namespace === "pi_" ? "pi-ui-entry:" : `${namespace}ui-entry:`}${inherited[0].id}`;
				const display = await storage.get<SessionMessage>(displayKey);
				if (
					display &&
					(await cutoverHash(display)) !== (await cutoverHash(message.display))
				)
					throw new Error("Cutover inherited display changed");
			}
			if (
				inherited.length > 1 ||
				inherited.some(
					(entry) =>
						JSON.stringify({
							kind: entry.kind,
							model: entry.model,
							data: entry.data,
						}) !== JSON.stringify(expected),
				)
			)
				throw new Error(
					"Cutover inherited entry conflicts with source projection",
				);
			const mappingKey = `pi-state-cutover:v1:${namespace}:conversation:${targetId}:message:${encodeURIComponent(message.id)}`;
			const existing = await storage.get<{ entryId?: number; sha256: string }>(
				mappingKey,
			);
			if (existing && existing.sha256 !== sha256)
				throw new Error("Cutover message changed after durable import");
			if (
				existing?.entryId !== undefined &&
				existing.entryId !== inherited[0]?.id
			)
				throw new Error("Cutover native entry mapping changed");
			if (
				!inherited.length &&
				visible.some((entry) => entry.kind !== expected.kind)
			)
				throw new Error(
					"Cutover cannot append historical rows after native cognition",
				);
			return { message, sha256, expected, mappingKey, inherited: inherited[0] };
		}),
	);
	const admissionKey = `${markerKey}:admission`;
	await storage.transaction(async (transaction) => {
		const admission = await transaction.get<{
			manifestHash: string;
			owner: CutoverOwner;
		}>(admissionKey);
		if (
			admission &&
			(admission.manifestHash !== manifestHash ||
				JSON.stringify(admission.owner) !== JSON.stringify(input.owner))
		)
			throw new Error("Cutover input changed after durable admission");
		if (!admission)
			await transaction.put(admissionKey, { manifestHash, owner: input.owner });
	});
	// Only an entirely empty store may use Harness to bootstrap its root/documents.
	// Populated stores never instantiate Harness or its task reconciler/scheduler.
	if (!target) {
		const bootstrap = await Harness.open(
			nativeStorage,
			{ models: createModels(), registry: createRegistry() },
			CONTEXT,
		);
		try {
			await bootstrap.root(CONTEXT);
		} finally {
			await bootstrap.close(CONTEXT);
		}
		nativeStorage = await openPiSessionStore(storage, { prefix: namespace });
		target = await nativeStorage.conversation(targetId, CONTEXT);
		if (!target) throw new Error("Cutover root bootstrap failed");
	}
	const session = createSession(nativeStorage);
	try {
		const entries: CutoverImportResult["entries"] = [];
		for (const plan of planned) {
			const { message, sha256, expected, mappingKey } = plan;
			const entryId = await session.commit(async (tx) => {
				const prior = await tx.submissionByRequest(
					targetId,
					`tedix:legacy:v1:${message.id}`,
				);
				if (prior) {
					if (prior.type !== "write" || prior.status !== "done")
						throw new Error("Cutover native submission is unresolved");
					const entry = await tx.entry(prior.entry);
					if (
						!entry ||
						JSON.stringify({
							kind: entry.kind,
							model: entry.model,
							data: entry.data,
						}) !== JSON.stringify(expected)
					)
						throw new Error(
							"Cutover native entry conflicts with source projection",
						);
					return prior.entry;
				}
				if (plan.inherited) return plan.inherited.id;
				const entry = await tx.appendEntry(targetId, expected);
				const submission = await tx.createSubmission({
					type: "write",
					status: "queued",
					conversationId: targetId,
					requestId: `tedix:legacy:v1:${message.id}`,
				});
				tx.placeSubmission(submission.id, entry.id);
				return entry.id;
			}, CONTEXT);
			const displayKey = `${namespace === "pi_" ? "pi-ui-entry:" : `${namespace}ui-entry:`}${entryId}`;
			const display = await storage.get<SessionMessage>(displayKey);
			if (
				display &&
				(await cutoverHash(display)) !== (await cutoverHash(message.display))
			)
				throw new Error("Cutover native display changed");
			await storage.put({
				[mappingKey]: { entryId, sha256 },
				[displayKey]: message.display,
			});
			entries.push({ messageId: message.id, entryId, sha256 });
		}
		const result = { manifestHash, entries };
		await storage.put(markerKey, { ...result, owner: input.owner });
		return result;
	} finally {
		await session.close(CONTEXT);
	}
}
