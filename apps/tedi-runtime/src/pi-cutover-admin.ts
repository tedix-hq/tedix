import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { createHash } from "node:crypto";
/** Temporary operator inventory boundary for explicitly enumerated stored objects. */
import { secureEqual } from "@tedix/worker-kit/request-auth";
import { cutoverHash } from "./pi-state-cutover";
import type { AdmissionSnapshot } from "./runtime-admission";
import {
	validateAccountingCheckpoint,
	pageCutoverInventory,
} from "./pi-cutover-operator";
import {
	assertStoredTelegramDisposition,
	readStoredRuntimeAdmission,
} from "./runtime-admission-do";
import {
	compareCutoverWorkflowIds,
	CutoverQualificationTables,
	CutoverQualificationFamilies,
	CutoverQualificationStates,
	CutoverQualificationFamilyStates,
	type CutoverQualification,
	CutoverInspectionHopSchema,
	CutoverSdkWorkflowRowSchema,
	CutoverSdkWorkflowStatusSchema,
	type CutoverSdkWorkflowRow,
} from "@tedix/api-contract/schemas/tedi";
import { z } from "zod";

export function cutoverObjectIds(value: string | undefined): Set<string> {
	if (value === undefined) return new Set();
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.length > 200 ||
		parsed.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
		new Set(parsed).size !== parsed.length
	)
		throw new Error("Invalid finite cutover object selection");
	return new Set(parsed);
}

export function isSelectedCutoverParent(
	id: string,
	selection?: string,
): boolean {
	return cutoverObjectIds(selection).has(id);
}

export interface CutoverInventoryPage {
	offset: number;
	limit: number;
	expectedHash?: string;
	expectedInspectionHash?: string;
}
export function cutoverInventoryPageQuery(
	params: URLSearchParams,
): CutoverInventoryPage {
	for (const key of [
		"offset",
		"limit",
		"expectedHash",
		"expectedInspectionHash",
	])
		if (params.getAll(key).length > 1) throw new Error("Invalid cutover page");
	const number = (key: string, fallback: number) => {
		const value = params.get(key);
		if (value === null) return fallback;
		if (
			!/^(0|[1-9][0-9]*)$/.test(value) ||
			!Number.isSafeInteger(Number(value))
		)
			throw new Error("Invalid cutover page");
		return Number(value);
	};
	const offset = number("offset", 0),
		limit = number("limit", 200),
		expectedHash = params.get("expectedHash"),
		expectedInspectionHash = params.get("expectedInspectionHash");
	if (
		limit < 1 ||
		limit > 200 ||
		(expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) ||
		(expectedInspectionHash !== null &&
			!/^[a-f0-9]{64}$/.test(expectedInspectionHash)) ||
		(offset > 0 && (expectedHash === null || expectedInspectionHash === null))
	)
		throw new Error("Invalid cutover page");
	return {
		offset,
		limit,
		...(expectedHash === null ? {} : { expectedHash }),
		...(expectedInspectionHash === null ? {} : { expectedInspectionHash }),
	};
}

// Bounded reads only. Opening either SDK store would migrate/resume it.
export const QUALIFICATION_MAX_ROWS = 20000;
export const QUALIFICATION_MAX_BYTES = 8 * 1024 * 1024;
export const QUALIFICATION_MAX_DEPTH = 64;
const QUALIFICATION_PREFIXES = [
	"think-accounting:",
	"pi-accounting:",
	"facet-pending-submission",
	"pi-facet-pending-submission",
	"pi-admitted-operation:v1",
	"pi:legacy-imported:v1",
	"pi-active-conversation-id:v1",
	"pi-ui-entry:",
	"__cf_messenger_recovery:",
	"cf:chat-recovery:incident:",
	"tedix:pi:telegram:reply:",
	"tedix:pi:maintenance:fire:",
	"workflow-image-cleanup:",
	"pi-state-cutover:v1:",
] as const;
const QUALIFICATION_COLUMNS = [
	"singleton:INTEGER,version:INTEGER",
	"singleton:INTEGER,next_id:TEXT,next_seq:INTEGER",
	"id:INTEGER,record_type:TEXT",
	"id:INTEGER,owner_conversation_id:INTEGER,owner_task_id:INTEGER,record:TEXT",
	"id:INTEGER,conversation_id:INTEGER,head:INTEGER,commit_seq:INTEGER,record:TEXT",
	"id:INTEGER,conversation_id:INTEGER,kind:TEXT,status:TEXT,abort_requested:INTEGER,background:INTEGER,record:TEXT",
	"id:INTEGER,conversation_id:INTEGER,request_id:TEXT,status:TEXT,record:TEXT",
	"id:INTEGER,kind:TEXT,family:INTEGER,key_value:TEXT,scope_kind:TEXT,owner_id:INTEGER,created_at:INTEGER,retired_at:INTEGER,record:TEXT",
	"document_id:INTEGER,seq:INTEGER,kind:TEXT,version:INTEGER,content:TEXT",
	"thread_id:TEXT",
	"thread_id:TEXT,token:TEXT,expires_at:INTEGER",
	"key:TEXT,value:TEXT,expires_at:INTEGER",
	"id:INTEGER,thread_id:TEXT,value:TEXT,enqueued_at:INTEGER,expires_at:INTEGER",
	"id:INTEGER,key:TEXT,value:TEXT,expires_at:INTEGER",
	"key:TEXT,value:TEXT",
] as const;
function qualificationUnavailable(): never {
	// Existing closed public verification_rejected mapping; no raw error text.
	throw new Error("Qualification capture unavailable");
}
function quoteInspectionIdentifier(name: string): string {
	return '"' + name.replaceAll('"', '""') + '"';
}
function projectionDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
class QualificationBudget {
	rows = 0;
	bytes = 0;
	addRows(count: number) {
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			this.rows + count > QUALIFICATION_MAX_ROWS
		)
			qualificationUnavailable();
		this.rows += count;
	}
	addBytes(count: number) {
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			this.bytes + count > QUALIFICATION_MAX_BYTES
		)
			qualificationUnavailable();
		this.bytes += count;
	}
	/** Tag types before serialization; never invoke toJSON, getters or coercions. */
	encode(value: unknown, blobs = false): string {
		const seen = new Set<object>();
		const walk = (v: unknown, depth: number): unknown => {
			if (depth > QUALIFICATION_MAX_DEPTH) qualificationUnavailable();
			if (v === null) {
				this.addBytes(8);
				return ["null"];
			}
			if (v === undefined) {
				this.addBytes(13);
				return ["undefined"];
			}
			if (typeof v === "boolean") {
				this.addBytes(v ? 16 : 17);
				return ["boolean", v];
			}
			if (typeof v === "number") {
				if (!Number.isFinite(v)) qualificationUnavailable();
				const n = Object.is(v, -0) ? "-0" : String(v);
				this.addBytes(13 + n.length);
				return ["number", n];
			}
			if (typeof v === "string") {
				// Calculate escaped UTF-8 length before allocating an escaped copy.
				let length = 2;
				for (let i = 0; i < v.length; i++) {
					const c = v.charCodeAt(i);
					if (c < 32) length += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
					else if (c === 34 || c === 92) length += 2;
					else if (c < 128) length++;
					else if (c < 2048) length += 2;
					else if (
						c >= 0xd800 &&
						c <= 0xdbff &&
						i + 1 < v.length &&
						v.charCodeAt(i + 1) >= 0xdc00 &&
						v.charCodeAt(i + 1) <= 0xdfff
					) {
						length += 4;
						i++;
					} else if (c >= 0xd800 && c <= 0xdfff) length += 6;
					else length += 3;
				}
				this.addBytes(11 + length);
				return ["string", v];
			}
			if (blobs && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) {
				const bytes =
					v instanceof ArrayBuffer
						? new Uint8Array(v)
						: new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
				this.addBytes(11 + 2 * bytes.length);
				return ["blob", Buffer.from(bytes).toString("hex")];
			}
			if (typeof v !== "object" || seen.has(v)) qualificationUnavailable();
			const proto = Object.getPrototypeOf(v);
			if (
				Array.isArray(v)
					? proto !== Array.prototype
					: proto !== Object.prototype && proto !== null
			)
				qualificationUnavailable();
			seen.add(v);
			const descriptors = Object.getOwnPropertyDescriptors(v);
			if (Reflect.ownKeys(descriptors).some((k) => typeof k !== "string"))
				qualificationUnavailable();
			let result: unknown;
			if (Array.isArray(v)) {
				if (Object.keys(descriptors).length !== v.length + 1)
					qualificationUnavailable();
				this.addBytes(12 + Math.max(0, v.length - 1));
				const children = [];
				for (let i = 0; i < v.length; i++) {
					const d = descriptors[String(i)];
					if (!d || !("value" in d)) qualificationUnavailable();
					children.push(walk(d.value, depth + 1));
				}
				result = ["array", children];
			} else {
				const keys = Object.keys(descriptors).sort();
				this.addBytes(13 + Math.max(0, keys.length - 1));
				const pairs = [];
				for (const key of keys) {
					const d = descriptors[key]!;
					if (!("value" in d) || !d.enumerable) qualificationUnavailable();
					this.addBytes(3);
					pairs.push([walk(key, depth + 1), walk(d.value, depth + 1)]);
				}
				result = ["object", pairs];
			}
			seen.delete(v);
			return result;
		};
		return JSON.stringify(walk(value, 0));
	}
}
function privateFrames(parts: string[], budget: QualificationBudget): string {
	const frames = parts.map((part) => {
		const prefix = String(part.length) + ":";
		budget.addBytes(prefix.length);
		return prefix + part;
	});
	return frames.join("");
}
function pinnedNativeDefinitions(table: string): string[] {
	const names = new Set(["durable_schema"]);
	for (const statement of SQLITE_MIGRATIONS[0]!.statements) {
		const match = /CREATE (?:TABLE|INDEX) ([A-Za-z_][A-Za-z0-9_]*)/.exec(
			statement,
		);
		if (match) names.add(match[1]!);
	}
	const pattern = new RegExp(`\\b(${[...names].join("|")})\\b`, "g");
	const statements = [
		"CREATE TABLE durable_schema ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0) ) STRICT",
		...SQLITE_MIGRATIONS[0]!.statements,
	];
	return statements
		.filter(
			(statement) =>
				statement.startsWith(`CREATE TABLE ${table.slice(3)} (`) ||
				new RegExp(`\\bON\\s+${table.slice(3)}\\s*\\(`).test(statement),
		)
		.map((statement) =>
			statement
				.split(/('(?:[^']|'')*')/)
				.map((part, index) =>
					index % 2 ? part : part.replace(pattern, (name) => `pi_${name}`),
				)
				.join("")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.sort();
}
function observationRecord(value: unknown): Record<string, unknown> | null {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
		? (value as Record<string, unknown>)
		: null;
}
function captureInspectionTable(
	storage: DurableObjectStorage,
	table: string,
	budget: QualificationBudget,
) {
	const definitionBudget = storage.sql
		.exec<{ rows: number; bytes: number }>(
			"SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(sql AS BLOB))+length(CAST(name AS BLOB))+length(CAST(type AS BLOB))+128),0) AS bytes FROM sqlite_master WHERE tbl_name=?",
			table,
		)
		.toArray()[0];
	if (
		!definitionBudget ||
		!Number.isSafeInteger(definitionBudget.bytes) ||
		definitionBudget.bytes < 0 ||
		budget.bytes + definitionBudget.bytes > QUALIFICATION_MAX_BYTES
	)
		qualificationUnavailable();
	budget.addRows(1);
	budget.addRows(definitionBudget.rows);
	const schema = storage.sql
		.exec<{ name: string; type: string }>(
			"SELECT * FROM pragma_table_info(?)",
			table,
		)
		.toArray();
	budget.addRows(schema.length);
	const definitions = storage.sql
		.exec<{ type: string; name: string; sql: string | null }>(
			"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name",
			table,
		)
		.toArray();
	if (definitions.length !== definitionBudget.rows) qualificationUnavailable();

	const definition = budget.encode(definitions);
	if (!schema.length) {
		if (definitions.length) qualificationUnavailable();
		return null;
	}
	const shape = budget.encode(schema);
	const name = quoteInspectionIdentifier(table),
		columns = schema.map((c) => quoteInspectionIdentifier(c.name));
	const estimate = columns
		.map(
			(c) =>
				`CASE typeof(${c}) WHEN 'text' THEN length(CAST(json_quote(${c}) AS BLOB))+64 WHEN 'blob' THEN length(${c})*2+64 ELSE 80 END`,
		)
		.join("+");
	const preflight = storage.sql
		.exec<{ rows: number; bytes: number }>(
			`SELECT COUNT(*) AS rows,COALESCE(SUM(${estimate}+${128 + schema.reduce((n, c) => n + 6 * c.name.length, 0)}),0) AS bytes FROM ${name}`,
		)
		.toArray()[0];
	budget.addRows(1);
	if (
		!preflight ||
		!Number.isSafeInteger(preflight.bytes) ||
		preflight.bytes < 0 ||
		budget.bytes + preflight.bytes > QUALIFICATION_MAX_BYTES
	)
		qualificationUnavailable();
	budget.addRows(preflight.rows);
	const rows = storage.sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT ${columns.join(",")} FROM ${name}`,
		)
		.toArray();
	if (rows.length !== preflight.rows) qualificationUnavailable();
	const encoded = rows.map((r) => budget.encode(r, true)).sort();
	return {
		schema,
		rows,
		definitions,
		raw: privateFrames([shape, definition, ...encoded], budget),
	};
}
function journalObservation(
	family: (typeof CutoverQualificationFamilies)[number],
	key: string,
	value: unknown,
) {
	const r = observationRecord(value);
	const result = {
		family,
		identityHash: null as string | null,
		projectionHash: null as string | null,
		structuralState: "unsupported" as "known" | "malformed" | "unsupported",
		observedState: "unknown" as (typeof CutoverQualificationStates)[number],
		completionValidation: "unknown" as "passed" | "not_passed" | "unknown",
		faultPresent: null as boolean | null,
		phaseCounts: {} as Partial<
			Record<(typeof CutoverQualificationStates)[number], number>
		>,
		unacknowledgedCount: null as number | null,
		unsealedEffectsCount: null as number | null,
		usageNullCounts: null as {
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
		} | null,
	};
	const known = () => {
		result.structuralState = "known";
		result.observedState = "present";
	};
	const expectedKeys = (allowed: string[]) =>
		r !== null && Object.keys(r).every((k) => allowed.includes(k));
	if (family === "legacy_import_marker") {
		if (typeof value === "boolean") known();
		else result.structuralState = "malformed";
	} else if (family === "native_active_conversation") {
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
			known();
		else result.structuralState = "malformed";
	} else if (family === "legacy_accounting" || family === "native_accounting") {
		if (
			r?.version !== 1 ||
			!expectedKeys([
				"version",
				"runId",
				"attempts",
				"fault",
				"receiptFault",
				"recoveredEffects",
			])
		)
			result.structuralState = r ? "unsupported" : "malformed";
		else if (
			r.runId !==
				key.slice(
					QUALIFICATION_PREFIXES[family === "legacy_accounting" ? 0 : 1].length,
				) ||
			typeof r.runId !== "string" ||
			!r.runId ||
			!Array.isArray(r.attempts) ||
			(r.fault !== null && typeof r.fault !== "string") ||
			(r.receiptFault !== undefined && typeof r.receiptFault !== "boolean")
		)
			result.structuralState = "malformed";
		else {
			known();
			result.faultPresent = r.fault !== null || r.receiptFault === true;
			result.unacknowledgedCount = 0;
			result.unsealedEffectsCount = 0;
			result.usageNullCounts = {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			};
			const ids = new Set<string>();
			for (const raw of r.attempts) {
				const a = observationRecord(raw),
					phase = a?.phase;
				if (
					!a ||
					typeof a.id !== "string" ||
					!a.id ||
					ids.has(a.id) ||
					typeof a.estimatedTokens !== "number" ||
					!Number.isSafeInteger(a.estimatedTokens) ||
					a.estimatedTokens <= 0 ||
					typeof phase !== "string" ||
					!["prepared", "started", "completed", "unknown"].includes(phase) ||
					typeof a.acknowledged !== "boolean" ||
					typeof a.effectsStarted !== "boolean" ||
					(a.effectsSealed !== undefined &&
						typeof a.effectsSealed !== "boolean")
				) {
					result.structuralState = "malformed";
					break;
				}
				if (
					Object.keys(a).some(
						(k) =>
							![
								"id",
								"estimatedTokens",
								"phase",
								"usage",
								"acknowledged",
								"effectsStarted",
								"effectIds",
								"effectTools",
								"effectsSealed",
								"generatedToolCallIds",
							].includes(k),
					)
				) {
					result.structuralState = "unsupported";
					break;
				}
				for (const key of ["effectIds", "generatedToolCallIds"]) {
					if (
						a[key] !== undefined &&
						(!Array.isArray(a[key]) ||
							(a[key] as unknown[]).some((v) => typeof v !== "string" || !v))
					)
						result.structuralState = "malformed";
				}
				if (
					a.effectTools !== undefined &&
					(!observationRecord(a.effectTools) ||
						Object.values(a.effectTools as Record<string, unknown>).some(
							(v) => typeof v !== "string" || !v,
						))
				)
					result.structuralState = "malformed";
				if (result.structuralState !== "known") break;
				ids.add(a.id);
				const usage = observationRecord(a.usage);
				if (
					usage &&
					Object.keys(usage).some(
						(k) => !["inputTokens", "outputTokens", "totalTokens"].includes(k),
					)
				) {
					result.structuralState = "unsupported";
					break;
				}
				if (
					phase === "completed"
						? !usage ||
							["inputTokens", "outputTokens", "totalTokens"].some(
								(k) =>
									usage[k] !== null &&
									(typeof usage[k] !== "number" ||
										!Number.isSafeInteger(usage[k]) ||
										(usage[k] as number) < 0),
							)
						: a.usage !== null
				) {
					result.structuralState = "malformed";
					break;
				}
				result.phaseCounts[phase as keyof typeof result.phaseCounts] =
					(result.phaseCounts[phase as keyof typeof result.phaseCounts] ?? 0) +
					1;
				if (!a.acknowledged) result.unacknowledgedCount++;
				if (a.effectsStarted && a.effectsSealed !== true)
					result.unsealedEffectsCount++;
				if (usage)
					for (const k of [
						"inputTokens",
						"outputTokens",
						"totalTokens",
					] as const)
						if (usage[k] === null) result.usageNullCounts[k]++;
			}
			if (result.structuralState === "known") {
				try {
					validateAccountingCheckpoint(key, value);
					result.completionValidation = "passed";
				} catch {
					result.completionValidation = "not_passed";
				}
			}
		}
	} else if (r) {
		const shapes: Partial<Record<typeof family, () => boolean>> = {
			native_pending: () =>
				typeof r.submissionId === "string" &&
				!!observationRecord(r.configuration) &&
				!!observationRecord(r.turnInput) &&
				expectedKeys(["submissionId", "configuration", "turnInput"]),
			native_admission_binding: () =>
				["runId", "operationId", "sessionKey"].every(
					(k) => typeof r[k] === "string",
				) && expectedKeys(["runId", "operationId", "sessionKey"]),
			native_display: () =>
				typeof r.id === "string" &&
				typeof r.role === "string" &&
				["user", "assistant", "system"].includes(r.role) &&
				Array.isArray(r.parts) &&
				expectedKeys(["id", "role", "parts", "metadata", "createdAt"]),
			image_cleanup: () =>
				r.kind === "workflow_image_cleanup" &&
				r.intent === "uploaded_images" &&
				["runId", "tediId", "orgId", "sessionKey", "workflowInstanceId"].every(
					(k) => typeof r[k] === "string",
				) &&
				!!observationRecord(r.authority) &&
				Array.isArray(r.refs) &&
				expectedKeys([
					"kind",
					"intent",
					"runId",
					"tediId",
					"orgId",
					"sessionKey",
					"workflowInstanceId",
					"authority",
					"refs",
					"dispatchRequested",
					"terminalIntent",
					"page",
					"completed",
				]),
			cutover_markers: () =>
				(typeof r.entryId === "number" &&
					typeof r.sha256 === "string" &&
					expectedKeys(["entryId", "sha256"])) ||
				(typeof r.manifestHash === "string" &&
					Array.isArray(r.entries) &&
					!!observationRecord(r.owner) &&
					expectedKeys(["manifestHash", "entries", "owner"])),
			native_telegram_delivery: () =>
				r.version === 1 &&
				!!observationRecord(r.operation) &&
				!!observationRecord(r.turn) &&
				!!observationRecord(r.thread) &&
				Object.hasOwn(r, "claim") &&
				expectedKeys([
					"version",
					"operation",
					"claim",
					"turn",
					"thread",
					"stage",
					"chunks",
					"nextChunk",
					"messageIds",
					"error",
				]),
			native_maintenance_fire: () =>
				!!observationRecord(r.operation) &&
				Object.hasOwn(r, "claim") &&
				expectedKeys([
					"operation",
					"claim",
					"stage",
					"effectReceipt",
					"uncertainEffect",
				]),
		};
		const shape = shapes[family];
		const recognized = shape
			? shape()
			: family === "legacy_messenger_recovery" || family === "chat_recovery";
		const candidate =
			family === "legacy_messenger_recovery" ||
			family === "native_telegram_delivery" ||
			family === "native_maintenance_fire"
				? r.stage
				: family === "chat_recovery"
					? r.status
					: family === "image_cleanup"
						? r.completed === true
							? "completed"
							: (observationRecord(r.page)?.stage ?? r.intent)
						: "present";
		// Observation only; no inferred terminal/financial authority.
		if (
			recognized &&
			typeof candidate === "string" &&
			CutoverQualificationFamilyStates[family].includes(
				candidate as (typeof CutoverQualificationStates)[number],
			)
		) {
			known();
			result.observedState = candidate as typeof result.observedState;
		}
		if (family === "native_telegram_delivery") {
			if (r.version !== 1) result.structuralState = "unsupported";
			else if (result.structuralState === "known") {
				try {
					assertStoredTelegramDisposition(key, value);
					result.completionValidation = "passed";
				} catch {
					result.completionValidation = "not_passed";
				}
			}
		}
	} else result.structuralState = "malformed";
	if (result.structuralState !== "known") {
		result.observedState = "unknown";
		result.phaseCounts = {};
		result.faultPresent = null;
		result.unacknowledgedCount = null;
		result.unsealedEffectsCount = null;
		result.usageNullCounts = null;
		result.completionValidation = "unknown";
	} else result.projectionHash = projectionDigest(result);
	return result;
}
/** Complete private captures are compared, never hashed into public metadata. */
export function captureCutoverQualification(storage: DurableObjectStorage) {
	const budget = new QualificationBudget(),
		privateFacts: string[] = [];
	const tables: CutoverQualification["tables"] = [];
	let nativeSchemaVersion: number | null = null;
	for (const [index, table] of CutoverQualificationTables.entries()) {
		const captured = captureInspectionTable(storage, table, budget);
		if (!captured) {
			tables.push({
				table,
				present: false,
				schemaState: "absent",
				rowCount: null,
				projectionHash: null,
				statusCounts: {},
			});
			privateFacts.push(budget.encode(table), budget.encode(null));
			continue;
		}
		privateFacts.push(budget.encode(table), captured.raw);
		const actual = captured.schema
			.map((c) => `${c.name}:${c.type.toUpperCase()}`)
			.sort()
			.join(",");
		const supported =
			actual === QUALIFICATION_COLUMNS[index]!.split(",").sort().join(",") &&
			(index >= 9 ||
				JSON.stringify(
					captured.definitions
						.filter((d) => d.sql !== null)
						.map((d) => d.sql!.replace(/\s+/g, " ").trim())
						.sort(),
				) === JSON.stringify(pinnedNativeDefinitions(table)));
		const statusCounts: CutoverQualification["tables"][number]["statusCounts"] =
			{};
		if (supported && (table === "pi_tasks" || table === "pi_submissions"))
			for (const row of captured.rows) {
				const states =
					table === "pi_tasks"
						? ["pending", "running", "waiting", "completing", "terminal"]
						: ["queued", "placed", "done", "unanswered"];
				const state =
					typeof row.status === "string" && states.includes(row.status)
						? (row.status as keyof typeof statusCounts)
						: "unknown";
				statusCounts[state] = (statusCounts[state] ?? 0) + 1;
			}
		if (
			table === "pi_durable_schema" &&
			supported &&
			captured.rows.length === 1 &&
			captured.rows[0]?.singleton === 1 &&
			typeof captured.rows[0].version === "number" &&
			Number.isSafeInteger(captured.rows[0].version) &&
			captured.rows[0].version >= 0
		)
			nativeSchemaVersion = captured.rows[0].version;
		const projection = {
			table,
			present: true,
			schemaState: supported ? ("supported" as const) : ("unknown" as const),
			rowCount: captured.rows.length,
			statusCounts,
		};
		tables.push({
			...projection,
			projectionHash: supported ? projectionDigest(projection) : null,
		});
	}
	// Original physical custody and owner/admission records, not post-await permission.
	for (const table of [
		"cf_agents_state",
		"runtime_admission",
		"cf_agents_sub_agents",
	]) {
		const captured = captureInspectionTable(storage, table, budget);
		privateFacts.push(
			budget.encode(table),
			captured?.raw ?? budget.encode(null),
		);
	}
	for (const key of [
		"__ps_name",
		"cf_agents_is_facet",
		"cf_agents_facet_name",
		"cf_agents_parent_path",
	]) {
		const facts = Array.from(
			storage.kv.list({ start: key, end: key + "\0", limit: 2 }),
		).filter(([name]) => name === key);
		budget.addRows(facts.length);
		privateFacts.push(budget.encode(key), budget.encode(facts));
	}
	const rows: Array<CutoverQualification["rows"][number]> = [];
	const journalFamilies: CutoverQualification["journalFamilies"] = [];
	for (const [index, family] of CutoverQualificationFamilies.entries()) {
		const prefix = QUALIFICATION_PREFIXES[index]!,
			summary = {
				family,
				count: 0,
				states: {} as CutoverQualification["journalFamilies"][number]["states"],
				malformedCount: 0,
				unsupportedCount: 0,
			};
		const single = !prefix.endsWith(":");
		const entries = single
			? storage.kv.list({ start: prefix, end: prefix + "\0", limit: 1 })
			: (function* () {
					let startAfter: string | undefined;
					while (true) {
						const entry = storage.kv
							.list({ prefix, startAfter, limit: 1 })
							[Symbol.iterator]()
							.next();
						if (entry.done) return;
						if (
							!entry.value[0].startsWith(prefix) ||
							(startAfter !== undefined &&
								compareCutoverWorkflowIds(entry.value[0], startAfter) <= 0)
						)
							qualificationUnavailable();
						yield entry.value;
						startAfter = entry.value[0];
					}
				})();
		// SyncKvStorage iterates keys in lexicographic order; preserve every row.
		for (const [key, value] of entries) {
			if (single && key !== prefix) continue;
			budget.addRows(1);
			const raw = budget.encode(value);
			privateFacts.push(budget.encode(family), budget.encode(key), raw);
			const observation = journalObservation(family, key, value);
			rows.push({ ordinal: rows.length, ...observation });
			summary.count++;
			summary.states[observation.observedState] =
				(summary.states[observation.observedState] ?? 0) + 1;
			if (observation.structuralState === "malformed") summary.malformedCount++;
			if (observation.structuralState === "unsupported")
				summary.unsupportedCount++;
		}
		journalFamilies.push(summary);
	}
	const native = tables.slice(0, 9),
		nativeSchemaState = native.every((t) => !t.present)
			? "absent"
			: native.every((t) => t.schemaState === "supported") &&
				  nativeSchemaVersion === 1
				? "supported"
				: "unknown";
	const projection: CutoverQualification = {
		nativeSchemaState,
		nativeSchemaVersion,
		tables,
		journalFamilies,
		journalCount: rows.length,
		offset: 0,
		rows,
	};
	return {
		projection,
		privateSnapshot: privateFrames(privateFacts, budget),
		privateBytes: budget.bytes,
		privateRows: budget.rows,
	};
}
function pinnedInspection(storage: DurableObjectStorage) {
	const original = captureCutoverQualification(storage);
	return {
		original,
		assert: () => {
			if (
				captureCutoverQualification(storage).privateSnapshot !==
				original.privateSnapshot
			)
				throw new Error("Inspection metadata changed");
		},
	};
}

export async function inspectCutoverParent(
	storage: DurableObjectStorage,
	id: string,
	page: CutoverInventoryPage = { offset: 0, limit: 200 },
	verifiedNamespace?: Pick<DurableObjectNamespace, "idFromName">,
	receiver?: "raw-cutover-v1",
) {
	if (
		page.offset > 0 &&
		(page.expectedHash === undefined ||
			page.expectedInspectionHash === undefined)
	)
		throw new Error("Invalid cutover page");
	const current = readStoredRuntimeAdmission(storage, id);
	const pinned = pinnedInspection(storage);
	const { inspectMaintenanceRecords } = await import("./pi-parent-services");
	assertInspectionEpoch(storage, id, current);
	pinned.assert();
	const inventory = await pageCutoverInventory(storage, page);
	assertInspectionEpoch(storage, id, current);
	pinned.assert();
	assertInspectionEpoch(storage, id, current);
	const inspectionTargets = verifiedNamespace
		? registeredInspectionTargets(
				storage,
				verifiedNamespace,
				inventory.hash,
				current?.generation ?? 0,
			)
		: [];
	if (
		verifiedNamespace &&
		inspectionTargets.length !== inventory.counts.children
	)
		throw new Error("Registered facet mismatch");
	const sdkWork = inspectSdkWork(storage),
		sdkWorkflows = inspectSdkWorkflowRows(storage),
		records = inspectMaintenanceRecords(storage);
	const inspectionHash = await cutoverHash({
		inventoryHash: inventory.hash,
		admission: current,
		sdkWork,
		sdkWorkflows,
		maintenanceJournal: records,
		inspectionTargets,
		targetsKnown: verifiedNamespace !== undefined,
		version: "pi-cutover-inspection-v2",
		qualification: pinned.original.projection,
	});
	assertInspectionEpoch(storage, id, current);
	pinned.assert();
	assertInspectionEpoch(storage, id, current);
	if (
		(verifiedNamespace !== undefined &&
			JSON.stringify(inspectionTargets) !==
				JSON.stringify(
					registeredInspectionTargets(
						storage,
						verifiedNamespace,
						inventory.hash,
						current?.generation ?? 0,
					),
				)) ||
		JSON.stringify(sdkWork) !== JSON.stringify(inspectSdkWork(storage)) ||
		JSON.stringify(sdkWorkflows) !==
			JSON.stringify(inspectSdkWorkflowRows(storage)) ||
		JSON.stringify(records) !==
			JSON.stringify(inspectMaintenanceRecords(storage))
	)
		throw new Error("Inspection metadata changed");
	if (
		page.expectedInspectionHash !== undefined &&
		page.expectedInspectionHash !== inspectionHash
	)
		throw new Error("Inspection metadata changed");
	return {
		...inventory,
		version: "pi-cutover-inspection-v2" as const,
		qualification: {
			...pinned.original.projection,
			offset: page.offset,
			rows: pinned.original.projection.rows.slice(
				page.offset,
				page.offset + page.limit,
			),
		},
		...(receiver ? { receiver } : {}),
		admission: current
			? { state: current.state, generation: current.generation }
			: null,
		inspectionHash,
		targetsKnown: verifiedNamespace !== undefined,
		inspectionTargets: inspectionTargets.slice(
			page.offset,
			page.offset + page.limit,
		),
		sdkWork,
		sdkWorkflows: {
			present: sdkWorkflows.present,
			count: sdkWorkflows.rows.length,
			offset: page.offset,
			rows: sdkWorkflows.rows.slice(page.offset, page.offset + page.limit),
		},
		maintenanceJournal: {
			count: records.length,
			offset: page.offset,
			records: records.slice(page.offset, page.offset + page.limit),
		},
		nextOffset:
			Math.max(
				...Object.values(inventory.counts).map(Number),
				records.length,
				sdkWorkflows.rows.length,
				pinned.original.projection.journalCount,
			) >
			page.offset + page.limit
				? page.offset + page.limit
				: null,
		ok: true,
		id,
		sampledAt: new Date().toISOString(),
	};
}

/** The finite inventory set prevents arbitrary IDs from creating empty objects. */
export async function routeCutoverInventory(input: {
	request: Request;
	masterKey?: string;
	knownIds?: string;
	env?: Cloudflare.Env;
	namespace: Pick<
		DurableObjectNamespace,
		"idFromString" | "idFromName" | "get"
	>;
}): Promise<Response | null> {
	input = Object.freeze({ ...input });
	const url = new URL(input.request.url);
	if (
		url.pathname === "/__admin/pi-state-cutover" &&
		input.request.method === "POST"
	) {
		let scope: CustodyReadScope | undefined;
		try {
			if (input.request.headers.has(CUSTODY_DEADLINE_HEADER))
				scope = custodyReadScope(
					input.request.headers.get(CUSTODY_DEADLINE_HEADER),
					input.request.signal,
				);
		} catch {
			return new Response("Cutover unavailable", { status: 409 });
		}
		if (scope) {
			input = Object.freeze({
				...input,
				namespace: Object.freeze({
					idFromName: input.namespace.idFromName.bind(input.namespace),
					idFromString: input.namespace.idFromString.bind(input.namespace),
					get: input.namespace.get.bind(input.namespace),
				}) as typeof input.namespace,
			});
		}
		const checked = <T>(read: () => Promise<T>) => {
			scope?.guard();
			return scope ? scope.checked(read()) : read();
		};
		try {
			if (
				!(await checked(() =>
					secureEqual(
						input.request.headers.get("X-Tedix-Admin-Token"),
						input.masterKey,
					),
				))
			)
				return new Response("Forbidden", { status: 403 });
		} catch {
			return new Response("Cutover unavailable", { status: 409 });
		}
		if (
			input.request.headers.has(FACET_CUSTODY_HEADER) ||
			input.request.headers.has(INSPECTION_CUSTODY_HEADER)
		)
			return new Response("Invalid cutover request", { status: 400 });
		let body: Awaited<ReturnType<typeof parseCutoverOperation>>;
		try {
			body = await checked(async () =>
				parseCutoverOperation(
					await checked(() => input.request.clone().json()),
				),
			);
		} catch {
			return new Response("Invalid cutover operation", { status: 400 });
		}
		if (body.query.command === "inspect_custody_coverage" && !scope)
			return new Response("Cutover unavailable", { status: 409 });
		if (!cutoverObjectIds(input.knownIds).has(body.query.objectId))
			return new Response("Unknown stored object", { status: 404 });
		if (!input.env) return new Response("Cutover unavailable", { status: 503 });
		try {
			await checked(() =>
				verifyCutoverCustody(input.env!, input.namespace, body, () =>
					scope?.guard(),
				),
			);
		} catch {
			return new Response("Cutover canonical custody mismatch", {
				status: 409,
			});
		}
		// Anonymous quarantine is finite physical custody; it never supplies an owner name.
		scope?.guard();
		const id = body.custody
			? input.namespace.idFromName(body.custody.objectName)
			: input.namespace.idFromString(body.query.objectId);
		scope?.guard();
		const stub = input.namespace.get(id);
		try {
			const forwarded = scope
				? new Request(input.request, { signal: scope.signal })
				: input.request;
			const result = await checked(() => stub.fetch(forwarded));
			scope?.guard();
			return result;
		} finally {
			(stub as typeof stub & { [Symbol.dispose]?: () => void })[
				Symbol.dispose
			]?.();
		}
	}
	if (
		url.pathname !== "/__admin/pi-state-cutover" ||
		!url.searchParams.has("objectId")
	)
		return null;
	if (input.request.method !== "GET")
		return new Response("Method Not Allowed", { status: 405 });
	if (
		!(await secureEqual(
			input.request.headers.get("X-Tedix-Admin-Token"),
			input.masterKey,
		))
	)
		return new Response("Forbidden", { status: 403 });
	if (
		input.request.headers.has(INSPECTION_CUSTODY_HEADER) ||
		input.request.headers.has(FACET_CUSTODY_HEADER)
	)
		return new Response("Invalid cutover request", { status: 400 });
	const id = url.searchParams.get("objectId") ?? "";
	if (!cutoverObjectIds(input.knownIds).has(id))
		return new Response("Unknown stored object", { status: 404 });
	try {
		cutoverInventoryPageQuery(url.searchParams);
	} catch {
		return new Response("Invalid cutover page", { status: 400 });
	}
	let objectId = input.namespace.idFromString(id);
	const encodedNames = url.searchParams.get("candidateObjectNames");
	if (encodedNames !== null) {
		let names: unknown;
		try {
			names = JSON.parse(encodedNames);
		} catch {
			return new Response("Invalid object name candidates", { status: 400 });
		}
		if (
			!Array.isArray(names) ||
			names.length > 100 ||
			names.some(
				(name) =>
					typeof name !== "string" || name.length < 1 || name.length > 1024,
			)
		)
			return new Response("Invalid object name candidates", { status: 400 });
		for (const name of names as string[]) {
			const named = input.namespace.idFromName(name);
			if (named.toString() === id) {
				objectId = named;
				break;
			}
		}
	}
	let routed = input.request;
	try {
		const inspection = inspectionQuery(url.searchParams);
		if (inspection.path.length || inspection.custodyTediId) {
			if (!input.env || !inspection.custodyTediId)
				throw new Error("Missing inspection custody");
			const { resolveTediRuntimeIdentity, getTediRuntimeCanonicalIsolateId } =
				await import("@tedix/db/queries/tedi-runtime-bootstrap");
			const owner = await resolveTediRuntimeIdentity(
				input.env.DB,
				inspection.custodyTediId,
				true,
			);
			const canonical = await getTediRuntimeCanonicalIsolateId(
				input.env.DB,
				inspection.custodyTediId,
			);
			if (
				!owner?.orgId ||
				owner.id !== inspection.custodyTediId ||
				!canonical.exists ||
				!canonical.isolateAgentId ||
				input.namespace.idFromName(canonical.isolateAgentId).toString() !== id
			)
				throw new Error("Cutover canonical custody mismatch");
			routed = new Request(input.request, {
				headers: new Headers(input.request.headers),
			});
			routed.headers.set(
				INSPECTION_CUSTODY_HEADER,
				JSON.stringify({
					rootId: id,
					tediId: owner.id,
					orgId: owner.orgId,
					objectName: canonical.isolateAgentId,
					parentPath: [],
					current: null,
				}),
			);
		}
	} catch {
		return new Response("Invalid inspection custody", { status: 400 });
	}
	const stub = input.namespace.get(objectId);
	try {
		return await stub.fetch(routed);
	} finally {
		(stub as typeof stub & { [Symbol.dispose]?: () => void })[
			Symbol.dispose
		]?.();
	}
}

/** Fixed operator refusal codes; never expose persisted data or provider error text. */
export function cutoverRejectionCode(error: unknown): string {
	if (error instanceof PassiveInspectionRefusal) return error.rejection;
	const message = error instanceof Error ? error.message : "";
	const reasons: Record<string, string> = {
		"Runtime admission storage: nonterminal or unknown SDK work":
			"nonterminal_sdk_work",
		"Runtime admission storage: nonterminal or unknown native work":
			"nonterminal_native_work",
		"Runtime admission storage: unsettled provider or effect receipt":
			"unsettled_provider_or_effect",
		"Runtime admission storage: unknown external effect receipt":
			"unknown_effect_receipt",
		"Runtime admission storage: missing stored owner": "missing_stored_owner",
		"Runtime admission storage: stored tenant owner mismatch":
			"stored_owner_mismatch",
		"Transcript cutover: no stored transcript": "no_stored_transcript",
		"Transcript cutover: stored ownership mismatch":
			"transcript_owner_mismatch",
		"Transcript cutover: unresolved source receipts":
			"unresolved_source_receipts",
		"Transcript cutover: unresolved accounting effects":
			"unresolved_accounting_effects",
		"Transcript cutover: unresolved native work": "unresolved_native_work",
		"Transcript cutover: original native active pointer is unknown":
			"unknown_native_active_pointer",
		"Transcript cutover: existing native cognition requires reconciliation":
			"existing_native_cognition",
		"Transcript cutover: missing attachment chunks":
			"missing_attachment_chunks",
		"Transcript cutover: missing message chunks": "missing_message_chunks",
		"Transcript cutover: message identity mismatch":
			"message_identity_mismatch",
		"Transcript cutover: orphan attachment reference":
			"orphan_attachment_reference",
		"Transcript cutover: attachment integrity mismatch":
			"attachment_integrity_mismatch",
		"Transcript cutover: cyclic source graph": "cyclic_source_graph",
		"Transcript cutover: duplicate sequence": "duplicate_sequence",
		"Transcript cutover: duplicate source identity":
			"duplicate_source_identity",
		"Transcript cutover: empty model contribution": "empty_model_contribution",
		"Transcript cutover: empty transcript is not a verified empty root":
			"empty_transcript_is_not_a_verified_empty_root",
		"Transcript cutover: existing image conflict": "existing_image_conflict",
		"Transcript cutover: existing native imported context conflict":
			"existing_native_imported_context_conflict",
		"Transcript cutover: foreign private image": "foreign_private_image",
		"Transcript cutover: immutable native manifest changed":
			"immutable_native_manifest_changed",
		"Transcript cutover: invalid attachment bytes": "invalid_attachment_bytes",
		"Transcript cutover: invalid compaction span": "invalid_compaction_span",
		"Transcript cutover: invalid image URL": "invalid_image_url",
		"Transcript cutover: invalid inline image": "invalid_inline_image",
		"Transcript cutover: invalid integer": "invalid_integer",
		"Transcript cutover: invalid message timestamp":
			"invalid_message_timestamp",
		"Transcript cutover: invalid native prefix": "invalid_native_prefix",
		"Transcript cutover: invalid object": "invalid_object",
		"Transcript cutover: invalid parent sequence": "invalid_parent_sequence",
		"Transcript cutover: invalid parts": "invalid_parts",
		"Transcript cutover: invalid persisted JSON": "invalid_persisted_json",
		"Transcript cutover: invalid string": "invalid_string",
		"Transcript cutover: invalid system contribution":
			"invalid_system_contribution",
		"Transcript cutover: invalid user contribution":
			"invalid_user_contribution",
		"Transcript cutover: manifest chunk mismatch": "manifest_chunk_mismatch",
		"Transcript cutover: message cycle": "message_cycle",
		"Transcript cutover: missing attachment payload":
			"missing_attachment_payload",
		"Transcript cutover: missing parent": "missing_parent",
		"Transcript cutover: missing tool result": "missing_tool_result",
		"Transcript cutover: conflicting tool result": "conflicting_tool_result",
		"Transcript cutover: native status conflict": "native_status_conflict",
		"Transcript cutover: noncanonical private image":
			"noncanonical_private_image",
		"Transcript cutover: reserved source image token":
			"reserved_source_image_token",
		"Transcript cutover: retained context conflict":
			"retained_context_conflict",
		"Transcript cutover: retained graph entry conflict":
			"retained_graph_entry_conflict",
		"Transcript cutover: retained source manifest conflict":
			"retained_source_manifest_conflict",
		"Transcript cutover: source or plan changed": "source_or_plan_changed",
		"Transcript cutover: stored descriptor conflict":
			"stored_descriptor_conflict",
		"Transcript cutover: stored display conflict": "stored_display_conflict",
		"Transcript cutover: stored source chunk conflict":
			"stored_source_chunk_conflict",
		"Transcript cutover: unresolved tool effect": "unresolved_tool_effect",
		"Transcript cutover: unsupported media": "unsupported_media",
		"Transcript cutover: unsupported role": "unsupported_role",
		"Admission epoch changed": "admission_epoch_changed",
		"Inspection tenant owner mismatch": "inspection_owner_mismatch",
		"Inspection stored owner unavailable": "inspection_owner_unavailable",
		"Inspection metadata changed": "inspection_metadata_changed",
		"Passive registered inspection unavailable":
			"passive_inspection_unavailable",
		"Cutover canonical custody mismatch": "canonical_custody_mismatch",
	};
	return (
		reasons[message] ??
		(message.startsWith("Transcript cutover:")
			? "transcript_validation"
			: "verification_rejected")
	);
}

const INSPECTION_CUSTODY_HEADER = "X-Tedix-Cutover-Inspection-Custody";
const FACET_CUSTODY_HEADER = "X-Tedix-Cutover-Facet-Custody";
const CUTOVER_PATH = "/__admin/pi-state-cutover";
/** Parse the trusted service-boundary body with the exact public command schema. */
export async function parseCutoverOperation(value: unknown) {
	const { z } = await import("zod");
	const { TediRuntimeCutoverOperationQuerySchema } =
		await import("@tedix/api-contract/schemas/tedi");
	const envelope = z.strictObject({
		custody: z
			.strictObject({
				tediId: z.string().uuid(),
				orgId: z.string().uuid(),
				objectName: z.string().min(1).max(1024),
			})
			.nullable(),
		operation: z.record(z.string(), z.unknown()),
	});
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid cutover operation");
	const { custody, ...operation } = value as Record<string, unknown>;
	const parsed = envelope.parse({ custody, operation });
	if ("routeTediId" in operation || "custodyTediId" in operation)
		throw new Error("Invalid cutover operation");
	const query = TediRuntimeCutoverOperationQuerySchema.parse({
		...parsed.operation,
		routeTediId: "00000000-0000-4000-8000-000000000001",
		...(parsed.custody ? { custodyTediId: parsed.custody.tediId } : {}),
	});
	return { query, custody: parsed.custody };
}

/** Independently resolve canonical D1 custody before touching a runtime object. */
async function verifyCutoverCustody(
	env: Cloudflare.Env,
	namespace: Pick<DurableObjectNamespace, "idFromName">,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
	recheck: () => void = () => {},
	storage?: DurableObjectStorage,
) {
	if (!body.custody) return;
	const { getTediRuntimeCanonicalIsolateId, resolveTediRuntimeIdentity } =
		await import("@tedix/db/queries/tedi-runtime-bootstrap");
	recheck();
	const canonical = await getTediRuntimeCanonicalIsolateId(
		env.DB,
		body.custody.tediId,
	);
	recheck();
	// The final row observes tenant and canonical name together, after all other awaited reads.
	const owner = await resolveTediRuntimeIdentity(
		env.DB,
		body.custody.tediId,
		true,
	);

	recheck();
	if (
		(isHistoricalCustodyCommand(body.query.command) ||
			isNativePreservationCommand(body.query.command)) &&
		owner?.id === body.custody.tediId &&
		owner.orgId === body.custody.orgId &&
		owner.isolateAgentId !== body.custody.objectName
	) {
		const { verifyRetainedRootCustody } =
			await import("./retained-root-custody");
		recheck();
		await verifyRetainedRootCustody(
			env,
			{
				tediId: body.custody.tediId,
				orgId: body.custody.orgId,
				objectId: body.query.objectId,
				objectName: body.custody.objectName,
				currentName: owner.isolateAgentId!,
				generation:
					("targetPath" in body.query
						? body.query.targetPath?.[0]?.parentGeneration
						: undefined) ?? body.query.expectedGeneration,
			},
			recheck,
			storage,
		);
		return JSON.stringify({ canonical, owner });
	}
	if (
		!canonical.exists ||
		canonical.isolateAgentId !== body.custody.objectName ||
		owner?.id !== body.custody.tediId ||
		owner.orgId !== body.custody.orgId ||
		owner.isolateAgentId !== body.custody.objectName ||
		namespace.idFromName(body.custody.objectName).toString() !==
			body.query.objectId
	)
		throw new Error("Cutover canonical custody mismatch");
	return JSON.stringify({ canonical, owner });
}

function isBoundedCustodyRead(command: string | undefined) {
	return (
		command === "inspect_session_rehydration" ||
		command === "inspect_custody_coverage"
	);
}
function isNativePreservationCommand(command: string) {
	return (
		command === "inspect_native_preservation" ||
		command === "capture_native_preservation" ||
		command === "audit_native_preservation" ||
		command === "inspect_sdk_preservation" ||
		command === "capture_sdk_preservation" ||
		command === "audit_sdk_preservation" ||
		command === "inspect_session_preservation" ||
		command === "capture_session_preservation" ||
		command === "audit_session_preservation" ||
		command === "inspect_session_rehydration" ||
		command === "inspect_custody_coverage"
	);
}
/** New preservation custody retains absent/null local owners as UNKNOWN; no activation claim. */
function nativePreservationFacts(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
	custody?: z.infer<typeof InspectionCustodySchema>,
	index = 0,
) {
	const { query: q, custody: owner } = body,
		id = ctx.id.toString(),
		path = ("targetPath" in q ? q.targetPath : undefined) ?? [],
		current = readStoredRuntimeAdmission(ctx.storage, id);
	if (
		!isNativePreservationCommand(q.command) ||
		!owner ||
		!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(q.objectId) ||
		!current ||
		!["held", "quarantined", "retired"].includes(current.state) ||
		current.owner.objectId !== id
	)
		throw new Error("Native preservation unavailable");
	const hop = index > 0 ? path[index - 1] : undefined,
		physicalName = hop ? (hop.identityName ?? hop.name) : owner.objectName;
	const expectedGeneration =
		index < path.length ? path[index]!.parentGeneration : q.expectedGeneration;
	const names = {
		name: ctx.storage.kv.get("__ps_name"),
		facet: ctx.storage.kv.get("cf_agents_is_facet"),
		facetName: ctx.storage.kv.get("cf_agents_facet_name"),
		parentPath: ctx.storage.kv.get("cf_agents_parent_path"),
	};
	if (
		current.generation !== expectedGeneration ||
		env.TEDI_AGENT.idFromName(physicalName).toString() !== id ||
		(ctx.id.name !== undefined && ctx.id.name !== physicalName) ||
		(names.name !== undefined && names.name !== physicalName)
	)
		throw new Error("Native preservation unavailable");
	const expectedPath = hop
		? [
				{ className: "AgentTediDO", name: owner.objectName },
				...path
					.slice(0, index - 1)
					.map((p) => ({ className: p.className, name: p.name })),
			]
		: [];
	if (
		hop
			? hop.objectId !== id ||
				!custody?.current ||
				custody.current.objectId !== id ||
				custody.current.className !== hop.className ||
				custody.current.name !== hop.name ||
				custody.current.identityName !== physicalName ||
				JSON.stringify(custody.parentPath) !== JSON.stringify(expectedPath) ||
				names.facet !== true ||
				names.facetName !== hop.name ||
				JSON.stringify(names.parentPath) !== JSON.stringify(expectedPath)
			: id !== q.objectId ||
				(names.facet !== undefined && names.facet !== false) ||
				(names.parentPath !== undefined &&
					JSON.stringify(names.parentPath) !== "[]")
	)
		throw new Error("Native preservation unavailable");
	const checkOwner = (v: { tediId?: unknown; orgId?: unknown }) => {
		for (const [key, want] of [
			["tediId", owner.tediId],
			["orgId", owner.orgId],
		] as const) {
			if (v[key] !== undefined && v[key] !== null && v[key] !== want)
				throw new Error("Native preservation unavailable");
		}
	};
	checkOwner(current.owner);
	const present =
		[
			...ctx.storage.sql.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_state'",
			),
		].length === 1;
	let state: string | null = null;
	if (present) {
		const rows = [
			...ctx.storage.sql.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			),
		];
		if (rows.length > 1) throw new Error("Native preservation unavailable");
		state = rows[0]?.state ?? null;
		if (state !== null) {
			const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(state));
			checkOwner(parsed);
			if (parsed.aigMetadata !== undefined && parsed.aigMetadata !== null)
				checkOwner(z.record(z.string(), z.unknown()).parse(parsed.aigMetadata));
		}
	}
	return JSON.stringify({ current, names, state, physicalName, expectedPath });
}
// This request-local guard stays inside the selected Raw receiver; only its value is serialized.
const SDK_PUBLICATION = Symbol("sdk-preservation-publication");
function publishSdkPreservation<T>(
	result: T,
	retain?: (guard: () => void) => void,
): T {
	if (result && typeof result === "object" && SDK_PUBLICATION in result) {
		const prepared = result as unknown as {
			value: T;
			[SDK_PUBLICATION]: () => void;
		};
		retain?.(prepared[SDK_PUBLICATION]);
		prepared[SDK_PUBLICATION]();
		return prepared.value;
	}
	return result;
}
const SDK_FAILURE = Symbol("sdk-preservation-failure");
function sdkFailureAtPublication(
	error: unknown,
	retain?: (guard: () => void) => void,
): unknown {
	if (error && typeof error === "object" && SDK_FAILURE in error) {
		const failure = error as { original: unknown; [SDK_FAILURE]: () => void };
		try {
			retain?.(failure[SDK_FAILURE]);
			failure[SDK_FAILURE]();
		} catch (guardFailure) {
			return guardFailure;
		}
		return failure.original;
	}
	return error;
}
async function runNativePreservation(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
	recheck: () => void,
	operationDeadline = performance.now() + 30_000,
	custodyScope?: CustodyReadScope,
) {
	const q = body.query,
		owner = body.custody;
	const qualificationDeadline =
		q.command === "inspect_session_rehydration" ||
		q.command === "inspect_custody_coverage"
			? operationDeadline
			: null;

	if (q.command === "inspect_custody_coverage") {
		if (!owner || !custodyScope) throw Error("Custody coverage unavailable");
		const guard = () => {
			custodyScope.guard();
			recheck();
			if (performance.now() >= operationDeadline)
				throw Error("Custody coverage unavailable");
		};
		const checked = <T>(p: Promise<T>) =>
			custodyScope.checked(p).finally(guard);
		const { prepareCustodyCoverage } = await checked(
			import("./custody-coverage-inventory"),
		);
		const { TediRuntimeCustodyCoverageResponseSchema } = await checked(
			import("@tedix/api-contract/schemas/tedi"),
		);
		const path = q.targetPath ?? [],
			hop = path.at(-1);
		let canonical: string | undefined;
		const operation = prepareCustodyCoverage({
			storage: ctx.storage,
			namespace: env.TEDI_AGENT,
			masterKey: env.SECRETS_MASTER_KEY,
			identity: {
				rootPhysicalId: q.objectId,
				targetPhysicalId: ctx.id.toString(),
				organizationId: owner.orgId,
				tediId: owner.tediId,
				operationId: q.operationId,
				namespaceClass: hop?.className ?? "AgentTediDO",
				targetName: hop ? (hop.identityName ?? hop.name) : owner.objectName,
				targetPath: path,
				generation: q.expectedGeneration,
				receiver: "raw-cutover-v1",
			},
			deadline: operationDeadline,
			signal: custodyScope.signal,
			recheck: guard,
			continuation: q.continuation,
			coverageHash: q.coverageHash,
			verifyCanonical: async () => {
				const value = await checked(
					verifyCutoverCustody(env, env.TEDI_AGENT, body, guard, ctx.storage),
				);
				if (canonical !== undefined && canonical !== value)
					throw Error("Custody coverage unavailable");
				canonical = value;
			},
		});
		const publication = () => {
			operation.assertContinuity();
			guard();
		};
		try {
			let result;
			try {
				result = await operation.result;
			} finally {
				publication();
			}
			operation.assertReady();
			const value = TediRuntimeCustodyCoverageResponseSchema.parse({
				ok: true,
				id: q.objectId,
				targetObjectId: ctx.id.toString(),
				command: q.command,
				operationId: q.operationId,
				generation: q.expectedGeneration,
				state: readStoredRuntimeAdmission(ctx.storage, ctx.id.toString())!
					.state,
				receiver: "raw-cutover-v1",
				...result,
			});
			publication();
			return {
				value,
				[SDK_PUBLICATION]: () => {
					publication();
					operation.assertReady();
				},
			};
		} catch (original) {
			throw { original, [SDK_FAILURE]: publication };
		}
	}

	if (
		q.command === "inspect_sdk_preservation" ||
		q.command === "capture_sdk_preservation" ||
		q.command === "audit_sdk_preservation"
	) {
		let firstGuard: unknown,
			guardFailed = false;
		const guard = () => {
			try {
				recheck();
			} catch (e) {
				if (!guardFailed) {
					guardFailed = true;
					firstGuard = e;
				}
			}
			if (guardFailed) throw firstGuard;
		};
		const checked = async <T>(p: Promise<T>): Promise<T> => {
			try {
				return await p;
			} finally {
				guard();
			}
		};
		if (!owner) throw Error("SDK preservation unavailable");
		const { SdkStatePreservation, SdkPreservationIntentSchema } = await checked(
			import("./sdk-state-preservation"),
		);
		const { TediRuntimeSdkPreservationResponseSchema } = await checked(
			import("@tedix/api-contract/schemas/tedi"),
		);
		const canonicalPin = await checked(
			verifyCutoverCustody(env, env.TEDI_AGENT, body, guard, ctx.storage),
		);
		const path = q.targetPath ?? [],
			hop = path.at(-1);
		const intent = SdkPreservationIntentSchema.parse({
			kind: "sdk-work-preservation-capture-v1",
			operationId: q.operationId,
			rootId: q.objectId,
			objectId: ctx.id.toString(),
			tediId: owner.tediId,
			orgId: owner.orgId,
			objectName: owner.objectName,
			physicalName: hop ? (hop.identityName ?? hop.name) : owner.objectName,
			className: hop?.className ?? "AgentTediDO",
			targetPath: path,
			generation: q.expectedGeneration,
		});
		const engine = new SdkStatePreservation(
			ctx.storage,
			intent,
			guard,
			async () => {
				const current = await checked(
					verifyCutoverCustody(env, env.TEDI_AGENT, body, guard, ctx.storage),
				);
				if (current !== canonicalPin)
					throw Error("SDK preservation unavailable");
			},
		);
		const operation =
			q.command === "inspect_sdk_preservation"
				? engine.inspect(env.SECRETS_MASTER_KEY)
				: q.command === "capture_sdk_preservation"
					? engine.capture(env.SECRETS_MASTER_KEY, q.archiveId, q.proof)
					: engine.audit(env.SECRETS_MASTER_KEY, q.archiveId);
		const publicationGuard = () => {
			operation.assertReady();
			guard();
		};
		try {
			let result;
			try {
				result = await checked(operation.result);
			} finally {
				operation.assertContinuity();
				guard();
			}
			publicationGuard();
			const { proof, ...archive } =
				result && "proof" in result ? result : { proof: undefined, ...result };
			const value = TediRuntimeSdkPreservationResponseSchema.parse({
				ok: true,
				id: q.objectId,
				targetObjectId: ctx.id.toString(),
				command: q.command,
				operationId: q.operationId,
				generation: q.expectedGeneration,
				state: readStoredRuntimeAdmission(ctx.storage, ctx.id.toString())!
					.state,
				receiver: "raw-cutover-v1",
				archive: result === null ? null : archive,
				...(proof === undefined ? {} : { proof }),
			});
			publicationGuard();
			return { value, [SDK_PUBLICATION]: publicationGuard };
		} catch (original) {
			throw {
				original,
				[SDK_FAILURE]: () => {
					operation.assertContinuity();
					guard();
				},
			};
		}
	}
	if (
		q.command === "inspect_session_preservation" ||
		q.command === "capture_session_preservation" ||
		q.command === "audit_session_preservation" ||
		q.command === "inspect_session_rehydration"
	) {
		if (!owner) throw new Error("Session preservation unavailable");
		const readGuard = () => {
			recheck();
			if (
				qualificationDeadline !== null &&
				performance.now() >= qualificationDeadline
			)
				throw new Error("Session qualification deadline expired");
		};
		const readChecked = async <T>(p: Promise<T>): Promise<T> => {
			if (qualificationDeadline === null) return p;
			const observed = Promise.resolve(p);
			void observed.catch(() => {});
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				readGuard();
				return await Promise.race([
					observed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Session qualification deadline expired")),
							Math.max(0, qualificationDeadline - performance.now()),
						);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				readGuard();
			}
		};
		const { SessionStatePreservation, SessionPreservationIntentSchema } =
			await readChecked(import("./session-state-preservation"));
		recheck();
		const {
			TediRuntimeSessionPreservationResponseSchema,
			TediRuntimeSessionRehydrationResponseSchema,
		} = await readChecked(import("@tedix/api-contract/schemas/tedi"));
		recheck();
		const canonicalPin = await readChecked(
			verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck, ctx.storage),
		);
		recheck();
		const path = q.targetPath ?? [],
			hop = path.at(-1);
		const intent = SessionPreservationIntentSchema.parse({
			kind: "session-preservation-capture-v1",
			operationId: q.operationId,
			rootId: q.objectId,
			objectId: ctx.id.toString(),
			tediId: owner.tediId,
			orgId: owner.orgId,
			objectName: owner.objectName,
			physicalName: hop ? (hop.identityName ?? hop.name) : owner.objectName,
			className: hop?.className ?? "AgentTediDO",
			targetPath: path,
			generation: q.expectedGeneration,
		});
		const engine = new SessionStatePreservation(
			ctx.storage,
			intent,
			readGuard,
			async () => {
				const current = await readChecked(
					verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck, ctx.storage),
				);
				recheck();
				if (current !== canonicalPin)
					throw new Error("Session preservation unavailable");
			},
		);

		if (q.command === "inspect_session_rehydration") {
			const operation = engine.prepareQualification(
				env.SECRETS_MASTER_KEY,
				q.archiveId,
				qualificationDeadline!,
			);
			const publicationGuard = () => {
				operation.assertContinuity();
				recheck();
			};
			try {
				let result;
				try {
					result = await operation.result;
				} finally {
					publicationGuard();
				}
				operation.assertReady();
				const value = TediRuntimeSessionRehydrationResponseSchema.parse({
					ok: true,
					id: q.objectId,
					targetObjectId: ctx.id.toString(),
					command: q.command,
					operationId: q.operationId,
					generation: q.expectedGeneration,
					state: readStoredRuntimeAdmission(ctx.storage, ctx.id.toString())!
						.state,
					receiver: "raw-cutover-v1",
					archive: result?.archive ?? null,
					qualification: result?.qualification ?? null,
				});
				publicationGuard();
				return {
					value,
					[SDK_PUBLICATION]: () => {
						publicationGuard();
						operation.assertReady();
					},
				};
			} catch (error) {
				throw { original: error, [SDK_FAILURE]: publicationGuard };
			}
		}
		const result =
			q.command === "inspect_session_preservation"
				? await engine.inspect(env.SECRETS_MASTER_KEY)
				: q.command === "capture_session_preservation"
					? await engine.capture(env.SECRETS_MASTER_KEY, q.archiveId, q.proof)
					: await engine.audit(env.SECRETS_MASTER_KEY, q.archiveId);
		recheck();
		const { proof, ...archive } =
			result && "proof" in result ? result : { proof: undefined, ...result };
		return TediRuntimeSessionPreservationResponseSchema.parse({
			ok: true,
			id: q.objectId,
			targetObjectId: ctx.id.toString(),
			command: q.command,
			operationId: q.operationId,
			generation: q.expectedGeneration,
			state: readStoredRuntimeAdmission(ctx.storage, ctx.id.toString())!.state,
			receiver: "raw-cutover-v1",
			archive: result === null ? null : archive,
			...(proof === undefined ? {} : { proof }),
		});
	}
	if (
		!owner ||
		!(
			q.command === "inspect_native_preservation" ||
			q.command === "capture_native_preservation" ||
			q.command === "audit_native_preservation"
		)
	)
		throw new Error("Native preservation unavailable");
	const { NativeStatePreservation, NativePreservationIntentSchema } =
		await import("./native-state-preservation");
	recheck();
	const { TediRuntimeNativePreservationResponseSchema } =
		await import("@tedix/api-contract/schemas/tedi");
	recheck();
	const canonicalPin = await verifyCutoverCustody(
		env,
		env.TEDI_AGENT,
		body,
		recheck,
		ctx.storage,
	);
	recheck();
	const path = q.targetPath ?? [],
		hop = path.at(-1);
	const intent = NativePreservationIntentSchema.parse({
		kind: "native-preservation-capture-v1",
		operationId: q.operationId,
		rootId: q.objectId,
		objectId: ctx.id.toString(),
		tediId: owner.tediId,
		orgId: owner.orgId,
		objectName: owner.objectName,
		physicalName: hop ? (hop.identityName ?? hop.name) : owner.objectName,
		className: hop?.className ?? "AgentTediDO",
		targetPath: path,
		generation: q.expectedGeneration,
	});
	const engine = new NativeStatePreservation(
		ctx.storage,
		intent,
		recheck,
		async () => {
			const current = await verifyCutoverCustody(
				env,
				env.TEDI_AGENT,
				body,
				recheck,
				ctx.storage,
			);
			recheck();
			if (current !== canonicalPin)
				throw new Error("Native preservation unavailable");
		},
	);
	const result =
		q.command === "inspect_native_preservation"
			? await engine.inspect(env.SECRETS_MASTER_KEY)
			: q.command === "capture_native_preservation"
				? await engine.capture(env.SECRETS_MASTER_KEY, q.archiveId, q.proof)
				: await engine.audit(env.SECRETS_MASTER_KEY, q.archiveId);
	recheck();
	const admission = readStoredRuntimeAdmission(ctx.storage, ctx.id.toString())!;
	const { proof, ...archive } =
		result && "proof" in result ? result : { proof: undefined, ...result };
	return TediRuntimeNativePreservationResponseSchema.parse({
		ok: true,
		id: q.objectId,
		targetObjectId: ctx.id.toString(),
		command: q.command,
		operationId: q.operationId,
		generation: q.expectedGeneration,
		state: admission.state,
		receiver: "raw-cutover-v1",
		archive: result === null ? null : archive,
		...(proof === undefined ? {} : { proof }),
	});
}
function isHistoricalCustodyCommand(command: string) {
	return (
		command === "inspect_historical_custody" ||
		command === "capture_historical_custody" ||
		command === "audit_historical_custody"
	);
}
/** Capture local custody without initializing or mutating storage. */
function nonactiveRootFacts(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	request: Request,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
): string {
	const { query: q, custody } = body,
		id = ctx.id.toString();
	const admission = readStoredRuntimeAdmission(ctx.storage, id);
	const name = ctx.storage.kv.get("__ps_name");
	const parentPath = ctx.storage.kv.get("cf_agents_parent_path");
	const isFacet = ctx.storage.kv.get("cf_agents_is_facet");
	if (
		(q.command !== "exclude_writers" &&
			!isHistoricalCustodyCommand(q.command)) ||
		!custody ||
		request.headers.has(FACET_CUSTODY_HEADER) ||
		request.headers.has(INSPECTION_CUSTODY_HEADER) ||
		(isFacet !== undefined && isFacet !== false) ||
		(parentPath !== undefined &&
			(!Array.isArray(parentPath) || parentPath.length !== 0)) ||
		!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(id) ||
		q.objectId !== id ||
		!admission ||
		!["held", "quarantined", "retired"].includes(admission.state) ||
		admission.generation !== q.expectedGeneration ||
		admission.owner.objectId !== id ||
		admission.owner.tediId !== custody.tediId ||
		admission.owner.orgId !== custody.orgId ||
		name !== custody.objectName ||
		(ctx.id.name !== undefined && ctx.id.name !== name) ||
		env.TEDI_AGENT.idFromName(custody.objectName).toString() !== id
	)
		throw new Error("Cutover canonical custody mismatch");
	const rows = ctx.storage.sql
		.exec<{ state: string }>(
			"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
		)
		.toArray();
	if (rows.length !== 1) throw new Error("Stored owner mismatch");
	const state: unknown = JSON.parse(rows[0]!.state);
	if (!state || typeof state !== "object" || Array.isArray(state))
		throw new Error("Stored owner mismatch");
	const stored = state as Record<string, unknown>;
	if (stored.tediId !== custody.tediId || stored.orgId !== custody.orgId)
		throw new Error("Stored owner mismatch");
	if (stored.aigMetadata !== undefined && stored.aigMetadata !== null) {
		const metadata = z
			.object({ tediId: z.string().optional(), orgId: z.string().optional() })
			.parse(stored.aigMetadata);
		if (
			(metadata.tediId !== undefined && metadata.tediId !== custody.tediId) ||
			(metadata.orgId !== undefined && metadata.orgId !== custody.orgId)
		)
			throw new Error("Stored owner mismatch");
	}
	return JSON.stringify({
		admission,
		name,
		parentPath,
		isFacet,
		state: rows[0]!.state,
	});
}

/** Diagnostic custody only: never constructs an admission store or changes an epoch. */
function captureSizeFacts(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	request: Request,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
) {
	const { query: q, custody } = body;
	const id = ctx.id.toString(),
		admission = readStoredRuntimeAdmission(ctx.storage, id);
	const name = ctx.storage.kv.get("__ps_name"),
		facet = ctx.storage.kv.get("cf_agents_is_facet"),
		path = ctx.storage.kv.get("cf_agents_parent_path");
	if (
		q.command !== "inspect_capture_size" ||
		!custody ||
		q.objectId !== id ||
		request.headers.has(FACET_CUSTODY_HEADER) ||
		request.headers.has(INSPECTION_CUSTODY_HEADER) ||
		!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(id) ||
		(facet !== undefined && facet !== false) ||
		(path !== undefined && (!Array.isArray(path) || path.length !== 0)) ||
		name !== custody.objectName ||
		(ctx.id.name !== undefined && ctx.id.name !== name) ||
		env.TEDI_AGENT.idFromName(custody.objectName).toString() !== id ||
		(admission?.generation ?? 0) !== q.expectedGeneration ||
		(admission &&
			(admission.owner.tediId !== custody.tediId ||
				admission.owner.orgId !== custody.orgId))
	)
		throw new Error("Cutover canonical custody mismatch");
	const rows = ctx.storage.sql
		.exec<{ state: string }>(
			"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
		)
		.toArray();
	if (rows.length !== 1) throw new Error("Stored owner mismatch");
	const state: unknown = JSON.parse(rows[0]!.state);
	if (!state || typeof state !== "object" || Array.isArray(state))
		throw new Error("Stored owner mismatch");
	const tenant = state as Record<string, unknown>;
	if (tenant.tediId !== custody.tediId || tenant.orgId !== custody.orgId)
		throw new Error("Stored owner mismatch");
	if (tenant.aigMetadata !== undefined && tenant.aigMetadata !== null) {
		const meta = z
			.object({ tediId: z.string().optional(), orgId: z.string().optional() })
			.parse(tenant.aigMetadata);
		if (
			(meta.tediId !== undefined && meta.tediId !== custody.tediId) ||
			(meta.orgId !== undefined && meta.orgId !== custody.orgId)
		)
			throw new Error("Stored owner mismatch");
	}
	return {
		fingerprint: JSON.stringify({
			admission,
			name,
			facet,
			path,
			state: rows[0]!.state,
		}),
		admission,
		identity: {
			objectId: id,
			tediId: custody.tediId,
			orgId: custody.orgId,
			objectName: custody.objectName,
			generation: q.expectedGeneration,
		},
	};
}
const CUSTODY_DEADLINE_HEADER = "X-Tedix-Custody-Deadline";
interface CustodyReadScope {
	readonly epochDeadline: number;
	readonly deadline: number;
	readonly signal: AbortSignal;
	guard(): void;
	checked<T>(read: Promise<T>): Promise<T>;
}
function custodyReadScope(
	epoch: unknown,
	signal?: AbortSignal,
): CustodyReadScope {
	const now = Date.now();
	if (typeof epoch === "string" && /^[0-9]{1,16}$/.test(epoch))
		epoch = Number(epoch);
	if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= now)
		throw Error("Custody coverage unavailable");
	const epochDeadline = Math.min(epoch, now + 30_000);
	const deadline = performance.now() + Math.min(30_000, epochDeadline - now);
	const controller = new AbortController();
	let failed = false,
		original: unknown;
	const refuse = () => {
		if (!failed) {
			failed = true;
			original = Error("Custody coverage unavailable");
		}
		if (!controller.signal.aborted) controller.abort(original);
		throw original;
	};
	const guard = () => {
		if (
			failed ||
			signal?.aborted ||
			Date.now() >= epochDeadline ||
			performance.now() >= deadline
		)
			refuse();
	};
	const checked = async <T>(read: Promise<T>): Promise<T> => {
		const observed = Promise.resolve(read);
		void observed.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		const stop = () => {
			try {
				refuse();
			} catch {}
		};
		signal?.addEventListener("abort", stop, { once: true });
		try {
			guard();
			return await Promise.race([
				observed,
				new Promise<never>((_, reject) => {
					abort = () => reject(original);
					controller.signal.addEventListener("abort", abort, { once: true });
					timer = setTimeout(
						() => {
							stop();
						},
						Math.max(
							0,
							Math.min(
								deadline - performance.now(),
								epochDeadline - Date.now(),
							),
						),
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			if (abort) controller.signal.removeEventListener("abort", abort);
			guard();
		}
	};
	return Object.freeze({
		epochDeadline,
		deadline,
		signal: controller.signal,
		guard,
		checked,
	});
}
/** Auth and request parsing share the original local transport deadline; archive execution has its own owning guards. */
async function initialCutoverRead<T>(
	read: Promise<T>,
	deadline: number,
): Promise<T> {
	const observed = Promise.resolve(read);
	void observed.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (performance.now() >= deadline)
			throw new Error("Cutover request deadline expired");
		const value = await Promise.race([
			observed,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Cutover request deadline expired")),
					Math.max(0, deadline - performance.now()),
				);
			}),
		]);
		if (performance.now() >= deadline)
			throw new Error("Cutover request deadline expired");
		return value;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
/** Storage-only authenticated boundary shared by cold Raw and already-warm original classes. */
export async function operateStoredCutover(input: {
	ctx: DurableObjectState;
	env: Cloudflare.Env;
	request: Request;
	receiver?: "raw-cutover-v1";
}): Promise<Response> {
	const { ctx, env, request } = input;
	let custodyScope: CustodyReadScope | undefined;
	try {
		if (request.headers.has(CUSTODY_DEADLINE_HEADER))
			custodyScope = custodyReadScope(
				request.headers.get(CUSTODY_DEADLINE_HEADER),
				request.signal,
			);
	} catch {
		return new Response("Cutover request unavailable", { status: 409 });
	}
	const operationDeadline =
		custodyScope?.deadline ?? performance.now() + 30_000;
	const initial = <T>(p: Promise<T>, deadline: number) =>
		custodyScope ? custodyScope.checked(p) : initialCutoverRead(p, deadline);
	let publication: () => void = () => {
		custodyScope?.guard();
		if (
			isBoundedCustodyRead(parsedBody?.query.command) &&
			performance.now() >= operationDeadline
		)
			throw new Error("Session qualification deadline expired");
	};
	const retain = (guard: () => void) => {
		publication = () => {
			custodyScope?.guard();
			guard();
		};
	};
	if (new URL(request.url).pathname !== CUTOVER_PATH)
		return new Response("Not Found", { status: 404 });
	try {
		if (
			!(await initial(
				secureEqual(
					request.headers.get("X-Tedix-Admin-Token"),
					env.SECRETS_MASTER_KEY,
				),
				operationDeadline,
			))
		)
			return new Response("Forbidden", { status: 403 });
	} catch {
		return new Response("Cutover request unavailable", { status: 409 });
	}
	if (request.method !== "GET" && request.method !== "POST")
		return new Response("Method Not Allowed", { status: 405 });
	// Return expected conflicts from inside the native gate; never throw them through it.
	let page: CutoverInventoryPage | undefined;
	let parsedBody: Awaited<ReturnType<typeof parseCutoverOperation>> | undefined;
	try {
		if (request.method === "GET")
			page = cutoverInventoryPageQuery(new URL(request.url).searchParams);
		else
			parsedBody = await initial(
				parseCutoverOperation(
					await initial(request.clone().json(), operationDeadline),
				),
				operationDeadline,
			);
	} catch {
		return new Response("Invalid cutover request", { status: 400 });
	}
	if (parsedBody?.query.command === "inspect_custody_coverage" && !custodyScope)
		return new Response("Cutover request unavailable", { status: 409 });
	const pending = ctx.blockConcurrencyWhile(async () => {
		try {
			custodyScope?.guard();
			if (request.method === "GET")
				return Response.json(
					await inspectRegisteredCutover(
						ctx,
						env,
						request,
						page!,
						input.receiver,
					),
				);
			const body = parsedBody!;
			publication();
			if (
				!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(
					body.query.objectId,
				)
			)
				return new Response("Unknown stored object", { status: 404 });
			if (
				"targetPath" in body.query &&
				body.query.targetPath &&
				(body.query.command === "quarantine" ||
					isHistoricalCustodyCommand(body.query.command) ||
					isNativePreservationCommand(body.query.command))
			) {
				if (
					input.receiver !== "raw-cutover-v1" ||
					request.headers.has(FACET_CUSTODY_HEADER) ||
					request.headers.has(INSPECTION_CUSTODY_HEADER)
				)
					throw new Error("Registered quarantine unavailable");
				return Response.json(
					publishSdkPreservation(
						await registeredStoredCutover(
							ctx,
							env,
							body,
							null,
							0,
							operationDeadline,
							custodyScope,
						),
						isBoundedCustodyRead(body.query.command) ? retain : undefined,
					),
				);
			}
			if (isNativePreservationCommand(body.query.command)) {
				if (
					input.receiver !== "raw-cutover-v1" ||
					request.headers.has(FACET_CUSTODY_HEADER) ||
					request.headers.has(INSPECTION_CUSTODY_HEADER)
				)
					throw new Error("Native preservation unavailable");
				const original = nativePreservationFacts(ctx, env, body);
				const recheck = () => {
					if (nativePreservationFacts(ctx, env, body) !== original)
						throw new Error("Native preservation unavailable");
				};
				return Response.json(
					publishSdkPreservation(
						await runNativePreservation(
							ctx,
							env,
							body,
							recheck,
							operationDeadline,
							custodyScope,
						),
						isBoundedCustodyRead(body.query.command) ? retain : undefined,
					),
				);
			}
			if (
				body.query.command === "inspect_historical_custody" ||
				body.query.command === "capture_historical_custody" ||
				body.query.command === "audit_historical_custody"
			) {
				if (input.receiver !== "raw-cutover-v1")
					throw new Error("Historical custody unavailable");
				const original = nonactiveRootFacts(ctx, env, request, body);
				const recheck = () => {
					if (nonactiveRootFacts(ctx, env, request, body) !== original)
						throw new Error("Historical custody unavailable");
				};
				const { HistoricalLiabilityCustody } =
					await import("./historical-liability-custody");
				recheck();
				const { TediRuntimeHistoricalCustodyResponseSchema } =
					await import("@tedix/api-contract/schemas/tedi");
				recheck();
				await verifyCutoverCustody(
					env,
					env.TEDI_AGENT,
					body,
					recheck,
					ctx.storage,
				);
				// Last asynchronous boundary. Local custody, engine transaction and summary serialization follow synchronously.
				recheck();
				const engine = new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				);
				const q = body.query;
				const summary =
					q.command === "inspect_historical_custody"
						? engine.inspectSnapshot({
								expectedGeneration: q.expectedGeneration,
							})
						: q.command === "capture_historical_custody"
							? engine.captureSnapshot({
									expectedGeneration: q.expectedGeneration,
									expectedSourceHash: q.expectedSourceHash,
								})
							: engine.audit();
				if (
					!summary ||
					summary.generation !== q.expectedGeneration ||
					(q.command !== "inspect_historical_custody" &&
						summary.sourceHash !== q.expectedSourceHash)
				)
					throw new Error("Historical custody unavailable");
				recheck();
				const state = readStoredRuntimeAdmission(
					ctx.storage,
					ctx.id.toString(),
				)!.state;
				return Response.json(
					TediRuntimeHistoricalCustodyResponseSchema.parse({
						ok: true,
						id: q.objectId,
						command: q.command,
						operationId: q.operationId,
						state,
						receiver: input.receiver,
						...summary,
					}),
				);
			}
			if (body.query.command === "inspect_capture_size") {
				const original = captureSizeFacts(ctx, env, request, body);
				const recheck = () => {
					if (
						captureSizeFacts(ctx, env, request, body).fingerprint !==
						original.fingerprint
					)
						throw new Error("Admission epoch changed");
				};
				await verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck);
				const { inspectHistoricalCaptureSize } =
					await import("./historical-capture-size");
				recheck();
				const metrics = await inspectHistoricalCaptureSize({
					storage: ctx.storage,
					identity: original.identity,
					masterKey: env.SECRETS_MASTER_KEY,
					continuation: body.query.continuation,
					recheck,
				});
				recheck();
				const { TediRuntimeCaptureSizeResponseSchema } =
					await import("@tedix/api-contract/schemas/tedi");
				recheck();
				// Reobserve canonical D1 after cursor crypto; this remains a read window, not a cross-store lock.
				await verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck);
				recheck();
				return Response.json(
					TediRuntimeCaptureSizeResponseSchema.parse({
						ok: true,
						id: body.query.objectId,
						command: body.query.command,
						operationId: body.query.operationId,
						generation: body.query.expectedGeneration,
						state: original.admission?.state ?? "uninitialized",
						...(input.receiver === undefined
							? {}
							: { receiver: input.receiver }),
						observation: "read_window_not_atomic_snapshot",
						sampledAt: new Date().toISOString(),
						...metrics,
					}),
				);
			}
			if (body.query.command === "exclude_writers") {
				const capture = () => nonactiveRootFacts(ctx, env, request, body);
				const original = capture();
				const recheck = () => {
					if (capture() !== original)
						throw new Error("Admission epoch changed");
				};
				await verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck);
				// LAST synchronous custody check. Abort is uncatchable: no receipt or write.
				recheck();
				ctx.abort("Tedix root writer exclusion", { retryAlarm: false });
			}
			await verifyCutoverCustody(env, env.TEDI_AGENT, body);
			return await runStoredCutover(ctx, env, request, body);
		} catch (cause) {
			const error = sdkFailureAtPublication(
				cause,
				isBoundedCustodyRead(parsedBody?.query.command) ? retain : undefined,
			);
			return Response.json(
				{
					ok: false,
					rejection:
						parsedBody && isHistoricalCustodyCommand(parsedBody.query.command)
							? "historical_custody_unavailable"
							: cutoverRejectionCode(error),
				},
				{
					status:
						error instanceof PassiveInspectionRefusal ? error.status : 409,
				},
			);
		}
	});
	let result: Response;
	try {
		result = isBoundedCustodyRead(parsedBody?.query.command)
			? await (custodyScope
					? custodyScope.checked(pending)
					: initialCutoverRead(pending, operationDeadline))
			: await pending;
	} catch (error) {
		let refusal = error;
		try {
			publication();
		} catch (guard) {
			refusal = guard;
		}
		return Response.json(
			{ ok: false, rejection: cutoverRejectionCode(refusal) },
			{ status: 409 },
		);
	}
	try {
		publication();
	} catch (error) {
		return Response.json(
			{ ok: false, rejection: cutoverRejectionCode(error) },
			{ status: 409 },
		);
	}
	return result;
}

async function runStoredCutover(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	request: Request,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
): Promise<Response> {
	const { RuntimeAdmissionDO, readStoredRuntimeAdmission } =
		await import("./runtime-admission-do");
	const { PiCutoverOperator } = await import("./pi-cutover-operator");
	const { TediRuntimeCutoverOperationResponseSchema } =
		await import("@tedix/api-contract/schemas/tedi");
	const { query: q, custody } = body;
	if (
		q.command === "inspect_native_preservation" ||
		q.command === "capture_native_preservation" ||
		q.command === "audit_native_preservation" ||
		q.command === "inspect_sdk_preservation" ||
		q.command === "capture_sdk_preservation" ||
		q.command === "audit_sdk_preservation" ||
		q.command === "inspect_session_preservation" ||
		q.command === "capture_session_preservation" ||
		q.command === "audit_session_preservation" ||
		q.command === "inspect_session_rehydration" ||
		q.command === "inspect_custody_coverage" ||
		q.command === "exclude_writers" ||
		q.command === "inspect_capture_size" ||
		q.command === "inspect_historical_custody" ||
		q.command === "capture_historical_custody" ||
		q.command === "audit_historical_custody"
	)
		throw new Error("Cutover verification rejected");
	const internal = request.headers.get(FACET_CUSTODY_HEADER);
	let facetCustody:
		| import("./runtime-admission-do").FacetAdmissionCustody
		| undefined;
	if (internal !== null) {
		const { z } = await import("zod");
		facetCustody = z
			.strictObject({
				parentPath: z.array(z.unknown()).min(1).max(32),
				facetName: z.string().min(1).max(512),
				identityName: z.string().min(1).max(1024),
				objectId: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.parse(JSON.parse(internal));
		if (
			!q.target ||
			!custody ||
			facetCustody.objectId !== ctx.id.toString() ||
			facetCustody.objectId !== q.target.objectId ||
			facetCustody.facetName !== q.target.name ||
			facetCustody.identityName !== (q.target.identityName ?? q.target.name)
		)
			throw new Error("Facet custody mismatch");
	} else {
		if (ctx.id.toString() !== q.objectId)
			throw new Error("Physical parent mismatch");
		if (q.target) {
			if (!custody) throw new Error("Missing facet custody");
			const root = readStoredRuntimeAdmission(ctx.storage, ctx.id.toString());
			if (
				!root ||
				root.state !== "held" ||
				root.generation !== q.target.parentGeneration ||
				root.owner.tediId !== custody.tediId ||
				root.owner.orgId !== custody.orgId
			)
				throw new Error("Parent hold changed");
			const page = await pageCutoverInventory(ctx.storage, {
				offset: 0,
				limit: 200,
			});
			if (page.hash !== q.target.registryHash)
				throw new Error("Registry changed");
			if (
				![
					"ConversationFacet",
					"JudgeSessionFacet",
					"SynthesisSessionFacet",
				].includes(q.target.className)
			)
				throw new Error("Unsupported registered class");
			const rows = ctx.storage.sql
				.exec<{
					class: string;
					name: string;
					identity_version: string | null;
					identity_name: string | null;
				}>(
					"SELECT class,name,identity_version,identity_name FROM cf_agents_sub_agents WHERE class=? AND name=?",
					q.target.className,
					q.target.name,
				)
				.toArray();
			const row = rows[0];
			if (
				!row ||
				rows.length !== 1 ||
				row.identity_version !== q.target.identityVersion ||
				row.identity_name !== q.target.identityName ||
				(row.identity_version !== null && row.identity_version !== "path-v2")
			)
				throw new Error("Registered facet mismatch");
			const native = ctx as DurableObjectState & {
				exports: Record<string, DurableObjectNamespace & object>;
			};
			const identityName = row.identity_name ?? row.name;
			const childId = env.TEDI_AGENT.idFromName(identityName);
			if (childId.toString() !== q.target.objectId)
				throw new Error("Physical facet mismatch");
			const storedPath =
				ctx.storage.kv.get<unknown[]>("cf_agents_parent_path") ?? [];
			const parentPath = [
				...storedPath,
				{ className: "AgentTediDO", name: custody.objectName },
			];
			// Root only: nested facet traversal must be admitted as a separate registered hop.
			if (storedPath.length !== 0)
				throw new Error("Nested registry unsupported");
			const forwarded = new Request(request, {
				headers: new Headers(request.headers),
			});
			forwarded.headers.set(
				FACET_CUSTODY_HEADER,
				JSON.stringify({
					parentPath,
					facetName: row.name,
					identityName,
					objectId: childId.toString(),
				}),
			);
			const key = `${row.class}\0${row.name}`;
			// No abort: warm original implements this passive port; cold uses Raw.
			const stub = ctx.facets.get(key, () => ({
				class: native.exports.RawCutoverDO,
				id: childId,
			}));
			try {
				return await stub.fetch(forwarded);
			} finally {
				(stub as typeof stub & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		}
	}
	if (custody) {
		// Selected SQL expressions need distinct names; never accept a request as stored ownership.
		const owned = ctx.storage.sql
			.exec<{ tediId: string | null; orgId: string | null }>(
				"SELECT json_extract(state,?) AS tediId,json_extract(state,?) AS orgId FROM cf_agents_state WHERE id='cf_state_row_id'",
				facetCustody ? "$.aigMetadata.tediId" : "$.tediId",
				facetCustody ? "$.aigMetadata.orgId" : "$.orgId",
			)
			.toArray()[0];
		if (owned?.tediId !== custody.tediId || owned.orgId !== custody.orgId)
			throw new Error("Stored owner mismatch");
		if (
			facetCustody &&
			(ctx.storage.kv.get("cf_agents_is_facet") !== true ||
				ctx.storage.kv.get("cf_agents_facet_name") !== facetCustody.facetName ||
				JSON.stringify(ctx.storage.kv.get("cf_agents_parent_path")) !==
					JSON.stringify(facetCustody.parentPath))
		)
			throw new Error("Stored facet custody mismatch");
	}
	const storedAdmission = custody
		? null
		: readStoredRuntimeAdmission(ctx.storage, ctx.id.toString());
	const owner = storedAdmission?.owner ?? {
		tediId: custody?.tediId ?? null,
		orgId: custody?.orgId ?? null,
		objectId: ctx.id.toString(),
	};
	const helper = new RuntimeAdmissionDO(ctx.storage, owner, facetCustody);
	const state = helper.read();
	const { cutoverHash } = await import("./pi-state-cutover");
	const receiptId = `${q.command}:${q.operationId}`;
	const inputHash = await cutoverHash(body);
	const receiptTable =
		ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='cutover_admin_receipts'",
			)
			.toArray().length > 0;
	if (receiptTable) {
		const row = ctx.storage.sql
			.exec<{ input_hash: string; response: string }>(
				"SELECT input_hash,response FROM cutover_admin_receipts WHERE id=?",
				receiptId,
			)
			.toArray()[0];
		if (row) {
			const prior = TediRuntimeCutoverOperationResponseSchema.parse(
				JSON.parse(row.response),
			);
			if (prior.command === "inspect_capture_size" || "snapshotId" in prior)
				throw new Error("Invalid mutation receipt");
			if (
				row.input_hash !== inputHash ||
				prior.id !== q.objectId ||
				prior.targetObjectId !==
					(facetCustody ? ctx.id.toString() : undefined) ||
				prior.generation !== (state?.generation ?? 0) ||
				prior.state !== (state?.state ?? "uninitialized")
			)
				throw new Error("Historical operator receipt is stale");
			return Response.json(prior);
		}
	}
	if (
		(state?.generation ?? 0) !== q.expectedGeneration &&
		q.command !== "bootstrap_prepare"
	)
		throw new Error("Admission epoch changed");
	// Already inside the owner's native input gate; avoid a nested barrier.
	const operator = new PiCutoverOperator(
		ctx.storage,
		helper.gate,
		() => {
			if (!custody) throw new Error("Unknown custody");
		},
		async (run) => run(),
	);
	let metadata: Record<string, unknown> = {};
	if (q.command === "plan") {
		if (!custody) throw new Error("Unknown custody");
		const { planPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		const plan = await planPiTranscriptCutover(ctx.storage, {
			tediId: custody.tediId,
			orgId: custody.orgId,
		});
		metadata = {
			sourceHash: plan.sourceHash,
			evidenceHash: await helper.prepareEvidence(q.verificationAction),
		};
	} else if (q.command === "quarantine") {
		if (!state)
			helper.gate.initialize({
				operationId: q.operationId,
				state: "quarantined",
				reason: q.reasonCode,
			});
		else
			helper.gate.quarantine({
				operationId: q.operationId,
				expectedGeneration: q.expectedGeneration,
				reason: q.reasonCode,
			});
	} else if (q.command === "prepare" || q.command === "bootstrap_prepare") {
		if (q.command === "bootstrap_prepare") {
			if (state) throw new Error("Admission already initialized");
			const { planPiTranscriptCutover } =
				await import("./pi-state-cutover-transcript");
			if (
				!custody ||
				(
					await planPiTranscriptCutover(ctx.storage, {
						tediId: custody.tediId,
						orgId: custody.orgId,
					})
				).sourceHash !== q.sourceHash
			)
				throw new Error("Source changed before initialize");
			if ((await helper.prepareEvidence("initialize")) !== q.evidenceHash)
				throw new Error("Baseline changed");
			const holdEvidence = await helper.prepareEvidence("hold");
			// The active intermediate state must never survive process loss. Both core
			// transitions and their synchronous evidence rereads commit atomically.
			ctx.storage.transactionSync(() => {
				helper.gate.initialize({
					operationId: `cutover-initialize:${q.operationId}`,
					state: "active",
					evidence: q.evidenceHash,
				});
				helper.gate.hold({
					operationId: `cutover-hold:${q.operationId}`,
					expectedGeneration: 1,
					evidence: holdEvidence,
				});
			});
		}
		try {
			const evidence = await helper.prepareEvidence("hold");
			if (q.command === "prepare" && evidence !== q.evidenceHash)
				throw new Error("Baseline changed");
			metadata = await operator.prepareCutover({
				operationId: q.operationId,
				expectedGeneration:
					q.command === "bootstrap_prepare" ? 1 : q.expectedGeneration,
				sourceHash: q.sourceHash,
				evidence,
			});
		} catch (error) {
			if (q.command === "bootstrap_prepare") {
				const live = helper.read();
				if (live?.state === "active")
					helper.gate.quarantine({
						operationId: `cutover-bootstrap-failure:${q.operationId}`,
						expectedGeneration: live.generation,
						reason: "operator_hold",
					});
			}
			throw error;
		}
	} else if (q.command === "apply")
		metadata = await operator.apply({
			operationId: q.operationId,
			generation: q.expectedGeneration,
			sourceHash: q.sourceHash,
		});
	else if (q.command === "release") {
		if ((await helper.prepareEvidence("release")) !== q.evidenceHash)
			throw new Error("Baseline changed");
		metadata = await operator.release({
			operationId: q.operationId,
			generation: q.expectedGeneration,
			sourceHash: q.sourceHash,
			evidence: q.evidenceHash,
		});
	} else {
		const row = ctx.storage.sql
			.exec<{ record: string }>(
				"SELECT record FROM pi_cutover_operator WHERE id=?",
				q.operationId,
			)
			.toArray()[0];
		const sourceHash: unknown = row ? JSON.parse(row.record).sourceHash : null;
		if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash))
			throw new Error("Missing applied plan");
		const accounting = {
			operationId: q.operationId,
			generation: q.expectedGeneration,
			sourceHash,
		};
		if (q.command === "inspect_accounting") {
			const receipt = await operator.inspectAccounting(accounting);
			metadata = {
				accountingManifestHash: receipt.accountingManifestHash,
				records: receipt.count,
			};
		} else {
			const receipt = await operator.transferAccounting({
				...accounting,
				accountingManifestHash: q.accountingManifestHash,
			});
			metadata = {
				accountingManifestHash: receipt.accountingManifestHash,
				records: receipt.count,
				sourceHashBefore: receipt.preSourceHash,
				sourceHashAfter: receipt.postSourceHash,
				destinationHashBefore: receipt.preDestinationHash,
				destinationHashAfter: receipt.postDestinationHash,
			};
		}
	}
	const current = helper.read();
	const response = TediRuntimeCutoverOperationResponseSchema.parse({
		...metadata,
		ok: true,
		id: q.objectId,
		...(facetCustody ? { targetObjectId: ctx.id.toString() } : {}),
		command: q.command,
		operationId: q.operationId,
		generation: current?.generation ?? 0,
		state: current?.state ?? "uninitialized",
	});
	ctx.storage.transactionSync(() => {
		const live = helper.read();
		if (
			(live?.generation ?? 0) !== response.generation ||
			(live?.state ?? "uninitialized") !== response.state
		)
			throw new Error("Operator receipt epoch changed");
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cutover_admin_receipts(id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,response TEXT NOT NULL)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cutover_admin_receipts VALUES(?,?,?)",
			receiptId,
			inputHash,
			JSON.stringify(response),
		);
	});
	return Response.json(response);
}

const InspectionCustodySchema = z.strictObject({
	rootId: z.string().regex(/^[a-f0-9]{64}$/),
	tediId: z.string().uuid(),
	orgId: z.string().uuid(),
	objectName: z.string().min(1).max(1024),
	parentPath: z
		.array(
			z.strictObject({
				className: z.string().min(1).max(128),
				name: z.string().min(1).max(1024),
			}),
		)
		.max(16),
	current: z
		.strictObject({
			className: z.string().min(1).max(128),
			name: z.string().min(1).max(512),
			identityName: z.string().min(1).max(1024),
			objectId: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.nullable(),
});
export function inspectionQuery(params: URLSearchParams) {
	for (const key of ["targetPath", "custodyTediId", "expectedGeneration"])
		if (params.getAll(key).length > 1)
			throw new Error("Invalid inspection query");
	const path = z
		.array(CutoverInspectionHopSchema)
		.max(16)
		.parse(
			params.has("targetPath") ? JSON.parse(params.get("targetPath")!) : [],
		);
	const custodyTediId = params.has("custodyTediId")
		? z.string().uuid().parse(params.get("custodyTediId"))
		: undefined;
	const encoded = params.get("expectedGeneration");
	if (encoded !== null && !/^(0|[1-9][0-9]*)$/.test(encoded))
		throw new Error("Invalid inspection generation");
	const expectedGeneration =
		encoded === null
			? undefined
			: z.number().int().nonnegative().safe().parse(Number(encoded));
	return { path, custodyTediId, expectedGeneration };
}

function registeredInspectionTargets(
	storage: DurableObjectStorage,
	namespace: Pick<DurableObjectNamespace, "idFromName">,
	registryHash: string,
	parentGeneration: number,
) {
	const columns = new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM pragma_table_info('cf_agents_sub_agents')",
			)
			.toArray()
			.map((row) => row.name),
	);
	if (!columns.size) return [];
	if (!columns.has("class") || !columns.has("name"))
		throw new Error("Registered facet mismatch");
	return storage.sql
		.exec<{
			class: string;
			name: string;
			identity_version: string | null;
			identity_name: string | null;
		}>(
			`SELECT class,name,${columns.has("identity_version") ? "identity_version" : "NULL AS identity_version"},${columns.has("identity_name") ? "identity_name" : "NULL AS identity_name"} FROM cf_agents_sub_agents`,
		)
		.toArray()
		.map((row) => ({
			className: row.class,
			name: row.name,
			identityVersion: row.identity_version,
			identityName: row.identity_name,
		}))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
		.map((row) => {
			const identity = row.identityName ?? row.name;
			if (typeof identity !== "string")
				throw new Error("Registered facet mismatch");
			const parsed = CutoverInspectionHopSchema.safeParse({
				...row,
				objectId: namespace.idFromName(identity).toString(),
				registryHash,
				parentGeneration,
			});
			if (!parsed.success) throw new Error("Registered facet mismatch");
			return parsed.data;
		});
}

function assertInspectionEpoch(
	storage: DurableObjectStorage,
	id: string,
	original: AdmissionSnapshot | null,
) {
	if (
		JSON.stringify(readStoredRuntimeAdmission(storage, id)) !==
		JSON.stringify(original)
	)
		throw new Error("Admission epoch changed");
}
function assertInspectionTenant(
	storage: DurableObjectStorage,
	custody: z.infer<typeof InspectionCustodySchema>,
	admission: AdmissionSnapshot | null,
) {
	const match = (owner: Record<string, unknown>) => {
		for (const key of ["tediId", "orgId"] as const) {
			const value = owner[key];
			if (
				value !== null &&
				value !== undefined &&
				(typeof value !== "string" || value !== custody[key])
			)
				throw new Error("Inspection tenant owner mismatch");
		}
	};
	if (admission) match(admission.owner as unknown as Record<string, unknown>);
	if (
		storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_state'",
			)
			.toArray().length
	) {
		const rows = storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			)
			.toArray();
		if (rows.length > 1) throw new Error("Inspection stored owner unavailable");
		if (rows.length) {
			let state: unknown;
			try {
				state = JSON.parse(rows[0]!.state);
			} catch {
				throw new Error("Inspection stored owner unavailable");
			}
			if (!state || typeof state !== "object" || Array.isArray(state))
				throw new Error("Inspection stored owner unavailable");
			const stored = state as Record<string, unknown>;
			match(stored);
			if (stored.aigMetadata !== undefined && stored.aigMetadata !== null) {
				if (
					typeof stored.aigMetadata !== "object" ||
					Array.isArray(stored.aigMetadata)
				)
					throw new Error("Inspection stored owner unavailable");
				match(stored.aigMetadata as Record<string, unknown>);
			}
		}
	}
}
const PASSIVE_REFUSAL_BYTES = 1024;
const PASSIVE_REFUSAL_READS = 16;
const PASSIVE_REFUSALS = new Set([
	"inspection_metadata_changed",
	"admission_epoch_changed",
	"inspection_owner_mismatch",
	"inspection_owner_unavailable",
	"canonical_custody_mismatch",
	"passive_inspection_unavailable",
	"verification_rejected",
]);
class PassiveInspectionRefusal extends Error {
	constructor(
		readonly status: number,
		readonly rejection: string,
	) {
		super("Passive registered inspection unavailable");
	}
}
function passiveRefusalCode(bytes: Uint8Array): string | null {
	if (bytes.byteLength > PASSIVE_REFUSAL_BYTES) return null;
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const keys = Object.keys(value),
			ok = Object.getOwnPropertyDescriptor(value, "ok"),
			rejection = Object.getOwnPropertyDescriptor(value, "rejection");
		return keys.length === 2 &&
			keys.includes("ok") &&
			keys.includes("rejection") &&
			ok &&
			"value" in ok &&
			ok.value === false &&
			rejection &&
			"value" in rejection &&
			typeof rejection.value === "string" &&
			PASSIVE_REFUSALS.has(rejection.value)
			? rejection.value
			: null;
	} catch {
		return null;
	}
}
async function readPassiveRefusal(
	response: Response,
	recheck: () => void,
): Promise<string | null> {
	if (!response.body) return null;
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	let guardFailed = false;
	let guardError: unknown;
	const guardedRecheck = () => {
		try {
			recheck();
		} catch (error) {
			if (!guardFailed) {
				guardFailed = true;
				guardError = error;
			}
		}
		if (guardFailed) throw guardError;
	};
	const releaseReader = () => {
		try {
			reader.releaseLock();
		} catch (error) {
			if (guardFailed) throw guardError;
			throw error;
		}
	};
	try {
		for (let reads = 0; reads < PASSIVE_REFUSAL_READS; reads++) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch {
				return null;
			} finally {
				guardedRecheck();
			}
			if (chunk.done) {
				const bytes = new Uint8Array(size);
				let offset = 0;
				for (const part of chunks) {
					bytes.set(part, offset);
					offset += part.byteLength;
				}
				return passiveRefusalCode(bytes);
			}
			if (chunk.value.byteLength > PASSIVE_REFUSAL_BYTES - size) return null;
			size += chunk.value.byteLength;
			chunks.push(chunk.value);
		}
		return null;
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* Refusal read failures remain closed. */
		} finally {
			try {
				guardedRecheck();
			} finally {
				releaseReader();
			}
		}
	}
}

export async function inspectRegisteredCutover(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	request: Request,
	page: CutoverInventoryPage,
	receiver?: "raw-cutover-v1",
) {
	const pinned = pinnedInspection(ctx.storage);
	const url = new URL(request.url),
		query = inspectionQuery(url.searchParams);
	const current = readStoredRuntimeAdmission(ctx.storage, ctx.id.toString());
	const encoded = request.headers.get(INSPECTION_CUSTODY_HEADER);
	const custody = encoded
		? InspectionCustodySchema.parse(JSON.parse(encoded))
		: null;
	if (custody) {
		if (!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(custody.rootId))
			throw new Error("Unknown inspection root");
		const { resolveTediRuntimeIdentity, getTediRuntimeCanonicalIsolateId } =
			await import("@tedix/db/queries/tedi-runtime-bootstrap");
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		const owner = await resolveTediRuntimeIdentity(
			env.DB,
			custody.tediId,
			true,
		);
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		const canonical = await getTediRuntimeCanonicalIsolateId(
			env.DB,
			custody.tediId,
		);
		if (
			owner?.id !== custody.tediId ||
			owner.orgId !== custody.orgId ||
			!canonical.exists ||
			canonical.isolateAgentId !== custody.objectName ||
			env.TEDI_AGENT.idFromName(custody.objectName).toString() !==
				custody.rootId
		)
			throw new Error("Cutover canonical custody mismatch");
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		assertInspectionTenant(ctx.storage, custody, current);
		if (custody.current) {
			if (
				ctx.id.toString() !== custody.current.objectId ||
				ctx.storage.kv.get("cf_agents_is_facet") !== true ||
				ctx.storage.kv.get("cf_agents_facet_name") !== custody.current.name ||
				JSON.stringify(ctx.storage.kv.get("cf_agents_parent_path")) !==
					JSON.stringify(custody.parentPath)
			)
				throw new Error("Facet custody mismatch");
		} else if (
			ctx.id.toString() !== custody.rootId ||
			ctx.storage.kv.get("cf_agents_is_facet") === true
		)
			throw new Error("Physical parent mismatch");
	}
	if (!query.path.length) {
		if (
			query.expectedGeneration !== undefined &&
			query.expectedGeneration !== (current?.generation ?? 0)
		)
			throw new Error("Admission epoch changed");
		const result = await inspectCutoverParent(
			ctx.storage,
			ctx.id.toString(),
			page,
			custody ? env.TEDI_AGENT : undefined,
			receiver,
		);
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		if (custody) assertInspectionTenant(ctx.storage, custody, current);
		return result;
	}
	if (!custody) throw new Error("Missing inspection custody");
	const hop = query.path[0]!;
	const registry = JSON.stringify(
		registeredInspectionTargets(
			ctx.storage,
			env.TEDI_AGENT,
			hop.registryHash,
			current?.generation ?? 0,
		),
	);
	const assertRegistry = () => {
		if (
			JSON.stringify(
				registeredInspectionTargets(
					ctx.storage,
					env.TEDI_AGENT,
					hop.registryHash,
					current?.generation ?? 0,
				),
			) !== registry
		)
			throw new Error("Registered facet mismatch");
	};
	const rest = query.path.slice(1);
	if (hop.parentGeneration !== (current?.generation ?? 0))
		throw new Error("Admission epoch changed");
	const inventory = await pageCutoverInventory(ctx.storage, {
		offset: 0,
		limit: 200,
	});
	assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
	pinned.assert();
	assertRegistry();
	assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
	assertInspectionTenant(ctx.storage, custody, current);
	if (inventory.hash !== hop.registryHash) throw new Error("Registry changed");
	const columns = new Set(
		ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM pragma_table_info('cf_agents_sub_agents')",
			)
			.toArray()
			.map((row) => row.name),
	);
	if (!columns.has("class") || !columns.has("name"))
		throw new Error("Registered facet mismatch");
	const rows = ctx.storage.sql
		.exec<{
			class: string;
			name: string;
			identity_version: string | null;
			identity_name: string | null;
		}>(
			`SELECT class,name,${columns.has("identity_version") ? "identity_version" : "NULL AS identity_version"},${columns.has("identity_name") ? "identity_name" : "NULL AS identity_name"} FROM cf_agents_sub_agents WHERE class=? AND name=?`,
			hop.className,
			hop.name,
		)
		.toArray();
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		row.identity_version !== hop.identityVersion ||
		row.identity_name !== hop.identityName ||
		(row.identity_version === "path-v2"
			? row.identity_name === null
			: row.identity_version !== null || row.identity_name !== null)
	)
		throw new Error("Registered facet mismatch");
	const identityName = row.identity_name ?? row.name,
		childId = env.TEDI_AGENT.idFromName(identityName);
	if (childId.toString() !== hop.objectId)
		throw new Error("Physical facet mismatch");
	const parentPath = [
		...custody.parentPath,
		{
			className: custody.current?.className ?? "AgentTediDO",
			name: custody.current?.name ?? custody.objectName,
		},
	];
	const forwarded = new URL(url);
	forwarded.searchParams.set("targetPath", JSON.stringify(rest));
	const forwardedCustody = {
		...custody,
		parentPath,
		current: {
			className: row.class,
			name: row.name,
			identityName,
			objectId: childId.toString(),
		},
	};
	const native = ctx as DurableObjectState & {
		exports: Record<string, DurableObjectNamespace & object>;
	};
	assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
	pinned.assert();
	assertRegistry();
	assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
	assertInspectionTenant(ctx.storage, custody, current);
	const stub = ctx.facets.get(`${row.class}\0${row.name}`, () => ({
		class: native.exports.RawCutoverDO,
		id: childId,
	}));
	try {
		const input = {
			url: forwarded.toString(),
			token: request.headers.get("X-Tedix-Admin-Token")!,
			custody: JSON.stringify(forwardedCustody),
		};
		const recheck = () => {
			assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
			pinned.assert();
			assertRegistry();
			assertInspectionTenant(ctx.storage, custody, current);
		};
		let response: Response;
		if (
			[
				"ConversationFacet",
				"JudgeSessionFacet",
				"SynthesisSessionFacet",
			].includes(row.class)
		) {
			response = await stub.fetch(
				new Request(input.url, {
					headers: {
						"X-Tedix-Admin-Token": input.token,
						[INSPECTION_CUSTODY_HEADER]: input.custody,
					},
				}),
			);
		} else {
			const result = await (
				stub as typeof stub & {
					inspectStoredCutover(
						input: PassiveCutoverInspection,
					): Promise<{ status: number; body: string }>;
				}
			).inspectStoredCutover(input);
			recheck();
			if (
				result.status < 100 ||
				result.status > 599 ||
				!Number.isSafeInteger(result.status)
			)
				throw new Error("Passive registered inspection unavailable");
			// Response cannot represent informational 1xx status. Keep the refusal closed.
			if (result.status < 200)
				throw new PassiveInspectionRefusal(
					409,
					"passive_inspection_unavailable",
				);
			if (result.status < 200 || result.status > 299) {
				const code =
					typeof result.body === "string" &&
					result.body.length <= PASSIVE_REFUSAL_BYTES
						? passiveRefusalCode(new TextEncoder().encode(result.body))
						: null;
				recheck();
				throw new PassiveInspectionRefusal(
					result.status,
					code ?? "passive_inspection_unavailable",
				);
			}
			response = new Response(result.body, { status: result.status });
		}
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		assertRegistry();
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		assertInspectionTenant(ctx.storage, custody, current);
		if (!response.ok) {
			const code = await readPassiveRefusal(response, recheck);
			recheck();
			throw new PassiveInspectionRefusal(
				response.status,
				code ?? "passive_inspection_unavailable",
			);
		}
		const result = await response.json();
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		pinned.assert();
		assertRegistry();
		assertInspectionEpoch(ctx.storage, ctx.id.toString(), current);
		assertInspectionTenant(ctx.storage, custody, current);
		return result;
	} finally {
		(stub as typeof stub & { [Symbol.dispose]?: () => void })[
			Symbol.dispose
		]?.();
	}
}
export interface PassiveCutoverInspection {
	url: string;
	token: string;
	custody: string;
}
export async function passiveCutoverInspection(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	input: PassiveCutoverInspection,
	receiver?: "raw-cutover-v1",
) {
	const response = await operateStoredCutover({
		receiver,
		ctx,
		env,
		request: new Request(input.url, {
			headers: {
				"X-Tedix-Admin-Token": input.token,
				[INSPECTION_CUSTODY_HEADER]: input.custody,
			},
		}),
	});
	return { status: response.status, body: await response.text() };
}

const SDK_WORK_TABLES = [
	"cf_agents_fibers",
	"cf_agents_runs",
	"cf_agents_task_runs",
	"cf_agents_workflows",
	"cf_agents_facet_runs",
] as const;
const SDK_STATUSES = [
	"queued",
	"paused",
	"errored",
	"terminated",
	"complete",
	"waiting",
	"waitingForPause",
	"pending",
	"running",
	"interrupted",
	"completed",
	"aborted",
	"error",
	"failed",
	"cancelled",
	"skipped",
	"unknown",
] as const;
export function inspectSdkWork(storage: Pick<DurableObjectStorage, "sql">) {
	return SDK_WORK_TABLES.map((table) => {
		const present =
			storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
					table,
				)
				.toArray().length === 1;
		if (!present) return { table, present: false, counts: {} };
		const columns = new Set(
			storage.sql
				.exec<{ name: string }>(
					`SELECT name FROM pragma_table_info('${table}')`,
				)
				.toArray()
				.map((row) => row.name),
		);
		const column = columns.has("status")
			? "status"
			: columns.has("state")
				? "state"
				: null;
		const expression = column
			? `CASE WHEN ${column} IN (${SDK_STATUSES.map((status) => "'" + status + "'").join(",")}) THEN ${column} ELSE 'unknown' END`
			: "'unknown'";
		const counts: Record<string, number> = {};
		for (const row of storage.sql
			.exec<{ status: string; count: number }>(
				`SELECT ${expression} AS status,count(*) AS count FROM ${table} GROUP BY ${expression}`,
			)
			.toArray())
			counts[row.status] = row.count;
		return { table, present: true, counts };
	});
}

/** Exact provider IDs from the SDK tracking cache, without params or error data. */
export function inspectSdkWorkflowRows(
	storage: Pick<DurableObjectStorage, "sql">,
): { present: boolean; rows: CutoverSdkWorkflowRow[] } {
	const present =
		storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
				"cf_agents_workflows",
			)
			.toArray().length === 1;
	if (!present) return { present: false, rows: [] };
	const columns = new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM pragma_table_info('cf_agents_workflows')",
			)
			.toArray()
			.map((row) => row.name),
	);
	for (const column of [
		"workflow_id",
		"workflow_name",
		"status",
		"created_at",
		"updated_at",
		"completed_at",
	])
		if (!columns.has(column))
			throw new Error("Unsupported SDK workflow metadata schema");
	const rows: CutoverSdkWorkflowRow[] = [];
	for (const row of storage.sql
		.exec<Record<string, SqlStorageValue>>(
			"SELECT workflow_id,workflow_name,status,created_at,updated_at,completed_at FROM cf_agents_workflows ORDER BY workflow_id COLLATE BINARY",
		)
		.toArray()) {
		const status = CutoverSdkWorkflowStatusSchema.safeParse(row.status);
		const parsed = CutoverSdkWorkflowRowSchema.safeParse({
			...row,
			status: status.success ? status.data : "unknown",
		});
		if (
			!parsed.success ||
			(rows.length > 0 &&
				compareCutoverWorkflowIds(
					rows.at(-1)!.workflow_id,
					parsed.data.workflow_id,
				) >= 0)
		)
			throw new Error("Invalid SDK workflow metadata");
		rows.push(parsed.data);
	}
	return { present: true, rows };
}

/** Private namespace RPC; the context is issued only by the gated canonical Raw root. */
export interface PassiveRegisteredCutover {
	token: string;
	body: string;
	custody: string;
	index: number;
	custodyDeadline?: number;
}
export async function passiveRegisteredCutover(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	input: PassiveRegisteredCutover,
) {
	input = Object.freeze({ ...input });
	let custodyScope: CustodyReadScope | undefined;
	try {
		if (input.custodyDeadline !== undefined)
			custodyScope = custodyReadScope(input.custodyDeadline);
	} catch {
		return { status: 409, body: "Registered quarantine unavailable" };
	}
	const operationDeadline =
		custodyScope?.deadline ?? performance.now() + 30_000;
	const initial = <T>(p: Promise<T>, deadline: number) =>
		custodyScope ? custodyScope.checked(p) : initialCutoverRead(p, deadline);
	let qualifying = false;
	let publication: () => void = () => {
		custodyScope?.guard();
		if (qualifying && performance.now() >= operationDeadline)
			throw new Error("Session qualification deadline expired");
	};
	const retain = (guard: () => void) => {
		publication = () => {
			custodyScope?.guard();
			guard();
		};
	};
	try {
		if (
			!(await initial(
				secureEqual(input.token, env.SECRETS_MASTER_KEY),
				operationDeadline,
			))
		)
			return { status: 403, body: "Forbidden" };
	} catch {
		return { status: 409, body: "Registered quarantine unavailable" };
	}
	let body: Awaited<ReturnType<typeof parseCutoverOperation>>;
	try {
		body = await initial(
			parseCutoverOperation(JSON.parse(input.body)),
			operationDeadline,
		);
	} catch {
		return { status: 409, body: "Registered quarantine unavailable" };
	}
	qualifying = isBoundedCustodyRead(body.query.command);
	if (body.query.command === "inspect_custody_coverage" && !custodyScope)
		return { status: 409, body: "Registered quarantine unavailable" };
	const pending = ctx.blockConcurrencyWhile(async () => {
		try {
			custodyScope?.guard();
			publication();
			const custody = InspectionCustodySchema.parse(JSON.parse(input.custody));
			const index = z.number().int().positive().max(16).parse(input.index);
			return {
				status: 200,
				body: JSON.stringify(
					publishSdkPreservation(
						await registeredStoredCutover(
							ctx,
							env,
							body,
							custody,
							index,
							operationDeadline,
							custodyScope,
						),
						isBoundedCustodyRead(body.query.command) ? retain : undefined,
					),
				),
			};
		} catch (error) {
			sdkFailureAtPublication(error, retain);
			return { status: 409, body: "Registered quarantine unavailable" };
		}
	});
	let result: { status: number; body: string };
	try {
		result = qualifying
			? await (custodyScope
					? custodyScope.checked(pending)
					: initialCutoverRead(pending, operationDeadline))
			: await pending;
	} catch {
		try {
			publication();
		} catch {}
		return { status: 409, body: "Registered quarantine unavailable" };
	}
	try {
		publication();
	} catch {
		return { status: 409, body: "Registered quarantine unavailable" };
	}
	return result;
}
async function registeredStoredCutover(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	body: Awaited<ReturnType<typeof parseCutoverOperation>>,
	forwarded: z.infer<typeof InspectionCustodySchema> | null,
	index: number,
	operationDeadline = performance.now() + 30_000,
	custodyScope?: CustodyReadScope,
): Promise<unknown> {
	const { query: q, custody: owner } = body;
	if (
		(q.command !== "quarantine" &&
			q.command !== "inspect_native_preservation" &&
			q.command !== "capture_native_preservation" &&
			q.command !== "audit_native_preservation" &&
			q.command !== "inspect_sdk_preservation" &&
			q.command !== "capture_sdk_preservation" &&
			q.command !== "audit_sdk_preservation" &&
			q.command !== "inspect_session_preservation" &&
			q.command !== "capture_session_preservation" &&
			q.command !== "audit_session_preservation" &&
			q.command !== "inspect_session_rehydration" &&
			q.command !== "inspect_custody_coverage" &&
			q.command !== "inspect_historical_custody" &&
			q.command !== "capture_historical_custody" &&
			q.command !== "audit_historical_custody") ||
		!q.targetPath ||
		!owner ||
		(q.command === "quarantine"
			? q.expectedGeneration !== 0
			: q.expectedGeneration < 1) ||
		("target" in q && q.target !== undefined)
	)
		throw new Error("Registered quarantine unavailable");
	const path = q.targetPath,
		id = ctx.id.toString();
	const current = readStoredRuntimeAdmission(ctx.storage, id);
	const custody =
		forwarded ??
		InspectionCustodySchema.parse({
			rootId: q.objectId,
			...owner,
			parentPath: [],
			current: null,
		});
	if (
		custody.rootId !== q.objectId ||
		custody.tediId !== owner.tediId ||
		custody.orgId !== owner.orgId ||
		custody.objectName !== owner.objectName ||
		!cutoverObjectIds(env.PI_CUTOVER_KNOWN_PARENT_IDS).has(q.objectId) ||
		index > path.length
	)
		throw new Error("Registered quarantine unavailable");
	const localFacts = () => {
		if (isNativePreservationCommand(q.command))
			return nativePreservationFacts(ctx, env, body, custody, index);
		assertInspectionEpoch(ctx.storage, id, current);
		const name = ctx.storage.kv.get("__ps_name"),
			facet = ctx.storage.kv.get("cf_agents_is_facet"),
			storedPath = ctx.storage.kv.get("cf_agents_parent_path");
		if (custody.current) {
			const original = path[index - 1];
			const expectedParentPath = [
				{ className: "AgentTediDO", name: owner.objectName },
				...path
					.slice(0, index - 1)
					.map((hop) => ({ className: hop.className, name: hop.name })),
			];
			if (
				JSON.stringify(custody.parentPath) !==
				JSON.stringify(expectedParentPath)
			)
				throw new Error("Registered quarantine unavailable");
			if (
				!original ||
				custody.current.objectId !== id ||
				original.objectId !== id ||
				original.className !== custody.current.className ||
				original.name !== custody.current.name ||
				(original.identityName ?? original.name) !==
					custody.current.identityName ||
				env.TEDI_AGENT.idFromName(custody.current.identityName).toString() !==
					id ||
				facet !== true ||
				ctx.storage.kv.get("cf_agents_facet_name") !== custody.current.name ||
				JSON.stringify(storedPath) !== JSON.stringify(custody.parentPath)
			)
				throw new Error("Registered quarantine unavailable");
		} else if (
			index !== 0 ||
			id !== q.objectId ||
			!current ||
			!["held", "quarantined", "retired"].includes(current.state) ||
			current.generation !== path[0]!.parentGeneration ||
			name !== owner.objectName ||
			(ctx.id.name !== undefined && ctx.id.name !== name) ||
			(facet !== undefined && facet !== false) ||
			(storedPath !== undefined && JSON.stringify(storedPath) !== "[]")
		)
			throw new Error("Registered quarantine unavailable");
		if (
			current &&
			(current.state === "active" ||
				current.owner.objectId !== id ||
				current.owner.tediId !== owner.tediId ||
				current.owner.orgId !== owner.orgId)
		)
			throw new Error("Registered quarantine unavailable");
		const rows = ctx.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			)
			.toArray();
		if (rows.length !== 1) throw new Error("Registered quarantine unavailable");
		const stored = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(rows[0]!.state));
		const metadata = custody.current
			? z.record(z.string(), z.unknown()).parse(stored.aigMetadata)
			: stored;
		if (metadata.tediId !== owner.tediId || metadata.orgId !== owner.orgId)
			throw new Error("Registered quarantine unavailable");
		assertInspectionTenant(ctx.storage, custody, current);
		return JSON.stringify({
			name,
			facet,
			storedPath,
			facetName: ctx.storage.kv.get("cf_agents_facet_name"),
			state: rows[0]!.state,
		});
	};
	const originalFacts = localFacts();
	const recheck = () => {
		custodyScope?.guard();
		if (localFacts() !== originalFacts)
			throw new Error("Registered quarantine unavailable");
	};
	if (index < path.length) {
		const hop = path[index]!;
		if (hop.parentGeneration !== (current?.generation ?? 0))
			throw new Error("Registered quarantine unavailable");
		const qualifying =
			q.command === "inspect_session_rehydration" ||
			q.command === "inspect_custody_coverage";
		const originalRegistry = qualifying
			? JSON.stringify(
					registeredInspectionTargets(
						ctx.storage,
						env.TEDI_AGENT,
						hop.registryHash,
						current?.generation ?? 0,
					),
				)
			: null;
		let first: unknown,
			failed = false;
		const continuity = () => {
			try {
				recheck();
				if (qualifying) {
					if (performance.now() >= operationDeadline)
						throw new Error("Session qualification deadline expired");
					if (
						JSON.stringify(
							registeredInspectionTargets(
								ctx.storage,
								env.TEDI_AGENT,
								hop.registryHash,
								current?.generation ?? 0,
							),
						) !== originalRegistry
					)
						throw new Error("Registered quarantine unavailable");
				}
			} catch (error) {
				if (!failed) {
					failed = true;
					first = error;
				}
			}
			if (failed) throw first;
		};
		const checked = async <T>(promise: Promise<T>): Promise<T> => {
			if (!qualifying) return promise;
			try {
				return await (custodyScope
					? custodyScope.checked(promise)
					: initialCutoverRead(promise, operationDeadline));
			} finally {
				continuity();
			}
		};
		try {
			const inventory = await checked(
				pageCutoverInventory(ctx.storage, {
					offset: 0,
					limit: 200,
				}),
			);
			recheck();
			if (inventory.hash !== hop.registryHash)
				throw new Error("Registered quarantine unavailable");
			const targets = registeredInspectionTargets(
				ctx.storage,
				env.TEDI_AGENT,
				inventory.hash,
				current?.generation ?? 0,
			);
			const matches = targets.filter(
				(row) => JSON.stringify(row) === JSON.stringify(hop),
			);
			if (matches.length !== 1)
				throw new Error("Registered quarantine unavailable");
			const registry = JSON.stringify(targets);
			const recheckRegistry = () => {
				recheck();
				if (
					JSON.stringify(
						registeredInspectionTargets(
							ctx.storage,
							env.TEDI_AGENT,
							inventory.hash,
							current?.generation ?? 0,
						),
					) !== registry
				)
					throw new Error("Registered quarantine unavailable");
			};
			await checked(
				verifyCutoverCustody(
					env,
					env.TEDI_AGENT,
					body,
					recheckRegistry,
					index === 0 ? ctx.storage : undefined,
				),
			);
			recheckRegistry();
			const childId = env.TEDI_AGENT.idFromName(hop.identityName ?? hop.name);
			const next = {
				...custody,
				parentPath: [
					...custody.parentPath,
					{
						className: custody.current?.className ?? "AgentTediDO",
						name: custody.current?.name ?? owner.objectName,
					},
				],
				current: {
					className: hop.className,
					name: hop.name,
					identityName: hop.identityName ?? hop.name,
					objectId: hop.objectId,
				},
			};
			const native = ctx as DurableObjectState & {
				exports: Record<string, DurableObjectNamespace & object>;
			};
			const stub = ctx.facets.get(`${hop.className}\0${hop.name}`, () => ({
				class: native.exports.RawCutoverDO,
				id: childId,
			}));
			try {
				const result = await checked(
					(
						stub as typeof stub & {
							operateRegisteredStoredCutover(
								input: PassiveRegisteredCutover,
							): Promise<{ status: number; body: string }>;
						}
					).operateRegisteredStoredCutover({
						token: env.SECRETS_MASTER_KEY,
						body: JSON.stringify({
							...q,
							custody: owner,
							routeTediId: undefined,
							custodyTediId: undefined,
						}),
						custody: JSON.stringify(next),
						index: index + 1,
						custodyDeadline:
							q.command === "inspect_custody_coverage"
								? custodyScope?.epochDeadline
								: undefined,
					}),
				);
				recheckRegistry();
				if (result.status !== 200)
					throw new Error("Registered quarantine unavailable");
				const response: unknown = JSON.parse(result.body);
				const { TediRuntimeCutoverOperationResponseSchema } = await checked(
					import("@tedix/api-contract/schemas/tedi"),
				);
				recheckRegistry();
				const parsed =
					TediRuntimeCutoverOperationResponseSchema.parse(response);
				if (q.command === "inspect_custody_coverage") {
					if (
						parsed.command !== q.command ||
						parsed.id !== q.objectId ||
						parsed.targetObjectId !== path.at(-1)!.objectId ||
						parsed.operationId !== q.operationId ||
						parsed.generation !== q.expectedGeneration ||
						(q.coverageHash !== undefined &&
							parsed.coverageHash !== q.coverageHash)
					)
						throw Error("Custody coverage unavailable");
					continuity();
					return { value: parsed, [SDK_PUBLICATION]: continuity };
				}

				if (
					q.command === "inspect_native_preservation" ||
					q.command === "capture_native_preservation" ||
					q.command === "audit_native_preservation" ||
					q.command === "inspect_sdk_preservation" ||
					q.command === "capture_sdk_preservation" ||
					q.command === "audit_sdk_preservation" ||
					q.command === "inspect_session_preservation" ||
					q.command === "capture_session_preservation" ||
					q.command === "audit_session_preservation" ||
					q.command === "inspect_session_rehydration"
				) {
					if (
						!("archive" in parsed) ||
						parsed.command !== q.command ||
						parsed.id !== q.objectId ||
						parsed.targetObjectId !== path.at(-1)!.objectId ||
						parsed.operationId !== q.operationId ||
						parsed.generation !== q.expectedGeneration ||
						("archiveId" in q &&
							parsed.archive !== null &&
							parsed.archive.archiveId !== q.archiveId)
					)
						throw new Error("Native preservation unavailable");
					if (qualifying) {
						continuity();
						return { value: parsed, [SDK_PUBLICATION]: continuity };
					}
					return parsed;
				}
				if (
					parsed.command !== q.command ||
					parsed.id !== q.objectId ||
					!("targetObjectId" in parsed) ||
					parsed.targetObjectId !== path.at(-1)!.objectId ||
					parsed.operationId !== q.operationId ||
					parsed.generation !==
						(q.command === "quarantine" ? 1 : q.expectedGeneration) ||
					(q.command === "quarantine"
						? parsed.state !== "quarantined"
						: !("snapshotId" in parsed) ||
							(q.command !== "inspect_historical_custody" &&
								parsed.sourceHash !== q.expectedSourceHash))
				)
					throw new Error("Registered quarantine unavailable");
				return parsed;
			} finally {
				(stub as typeof stub & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		} catch (error) {
			if (qualifying) throw { original: error, [SDK_FAILURE]: continuity };
			throw error;
		}
	}
	if (!custody.current) throw new Error("Registered quarantine unavailable");
	if (
		q.command === "inspect_native_preservation" ||
		q.command === "capture_native_preservation" ||
		q.command === "audit_native_preservation" ||
		q.command === "inspect_sdk_preservation" ||
		q.command === "capture_sdk_preservation" ||
		q.command === "audit_sdk_preservation" ||
		q.command === "inspect_session_preservation" ||
		q.command === "capture_session_preservation" ||
		q.command === "audit_session_preservation" ||
		q.command === "inspect_session_rehydration" ||
		q.command === "inspect_custody_coverage"
	)
		return runNativePreservation(
			ctx,
			env,
			body,
			recheck,
			operationDeadline,
			custodyScope,
		);
	if (q.command !== "quarantine") {
		if (!current || current.generation !== q.expectedGeneration)
			throw new Error("Historical custody unavailable");
		const { HistoricalLiabilityCustody } =
			await import("./historical-liability-custody");
		recheck();
		const { TediRuntimeHistoricalCustodyResponseSchema } =
			await import("@tedix/api-contract/schemas/tedi");
		recheck();
		await verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck);
		// Final canonical read has completed. Physical leaf custody and archive operations are synchronous.
		recheck();
		const engine = new HistoricalLiabilityCustody(ctx.storage, id);
		const summary =
			q.command === "inspect_historical_custody"
				? engine.inspectSnapshot({ expectedGeneration: q.expectedGeneration })
				: q.command === "capture_historical_custody"
					? engine.captureSnapshot({
							expectedGeneration: q.expectedGeneration,
							expectedSourceHash: q.expectedSourceHash,
						})
					: engine.audit();
		if (
			!summary ||
			summary.generation !== q.expectedGeneration ||
			(q.command !== "inspect_historical_custody" &&
				summary.sourceHash !== q.expectedSourceHash)
		)
			throw new Error("Historical custody unavailable");
		recheck();
		return TediRuntimeHistoricalCustodyResponseSchema.parse({
			ok: true,
			id: q.objectId,
			targetObjectId: id,
			command: q.command,
			operationId: q.operationId,
			state: current.state,
			receiver: "raw-cutover-v1",
			...summary,
		});
	}

	const { RuntimeAdmissionDO } = await import("./runtime-admission-do");
	recheck();
	const { TediRuntimeCutoverOperationResponseSchema } =
		await import("@tedix/api-contract/schemas/tedi");
	recheck();
	const inputHash = await cutoverHash({ body, custody });
	recheck();
	await verifyCutoverCustody(env, env.TEDI_AGENT, body, recheck);
	// Last await: actual stored physical custody and immutable receipt/state change follow synchronously.
	recheck();
	return ctx.storage.transactionSync(() => {
		recheck();
		const helper = new RuntimeAdmissionDO(
			ctx.storage,
			{ tediId: owner.tediId, orgId: owner.orgId, objectId: id },
			{
				parentPath: custody.parentPath,
				facetName: custody.current!.name,
				identityName: custody.current!.identityName,
				objectId: id,
			},
		);
		const receiptId = `quarantine:${q.operationId}`;
		const exists = ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='cutover_admin_receipts'",
			)
			.toArray().length;
		const prior = exists
			? ctx.storage.sql
					.exec<{ input_hash: string; response: string }>(
						"SELECT input_hash,response FROM cutover_admin_receipts WHERE id=?",
						receiptId,
					)
					.toArray()[0]
			: undefined;
		if (prior) {
			const response = TediRuntimeCutoverOperationResponseSchema.parse(
				JSON.parse(prior.response),
			);
			if (
				prior.input_hash !== inputHash ||
				response.command !== "quarantine" ||
				response.id !== q.objectId ||
				response.targetObjectId !== id ||
				response.operationId !== q.operationId ||
				response.generation !== 1 ||
				response.state !== "quarantined" ||
				current?.generation !== 1 ||
				current.state !== "quarantined" ||
				current.reason !== q.reasonCode ||
				current.evidence !== null
			)
				throw new Error("Registered quarantine unavailable");
			return response;
		}
		if (current) throw new Error("Registered quarantine unavailable");
		const state = helper.gate.initialize({
			operationId: q.operationId,
			state: "quarantined",
			reason: q.reasonCode,
		});
		const response = TediRuntimeCutoverOperationResponseSchema.parse({
			ok: true,
			id: q.objectId,
			targetObjectId: id,
			command: q.command,
			operationId: q.operationId,
			generation: state.generation,
			state: state.state,
		});
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cutover_admin_receipts(id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,response TEXT NOT NULL)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cutover_admin_receipts VALUES(?,?,?)",
			receiptId,
			inputHash,
			JSON.stringify(response),
		);
		return response;
	});
}
