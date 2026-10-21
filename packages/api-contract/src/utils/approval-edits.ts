/**
 * Derive and apply approver edits for a pending tool action.
 *
 * Editable fields come from the tool's own input schema: a tool's policy
 * metadata may name them (`approvalEditableFields`); otherwise destination-like
 * inputs are excluded. Tenant-pinned inputs are never editable. Only scalars
 * (string, number, integer, boolean, or a primitive enum) qualify, so each
 * edit can be checked against its exact property schema.
 */

import * as z from "zod";
import type { JsonValue } from "../schemas/common";
import {
	type ApprovalEditableField,
	ApprovalEditableFieldsSchema,
	type ApprovalFieldChange,
	type ApproverEditsRecord,
	MAX_APPROVAL_EDITABLE_FIELDS,
} from "../schemas/approval-edits";

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const MAX_PROPERTY_SCHEMA_LENGTH = 2_000;
const MAX_EDIT_VALUE_LENGTH = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Edits run with the requester's credentials, so routing needs explicit policy. */
function destinationLikeInput(
	name: string,
	schema: Record<string, unknown>,
): boolean {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return (
		words.some((word) =>
			/^(?:recipients?|to|cc|bcc|from|email|emails|address|addresses|url|uri|endpoint|webhook|channel|channels|path|paths|repo|repository|branch|account|connection|workspace|org|organization|tenant|destination|target|id|ids)$/.test(
				word,
			),
		) ||
		/(?:id|ids|url|uri|email|endpoint|webhook|path)$/.test(
			name.toLowerCase(),
		) ||
		/^(?:recipients?|email|channel|repo|repository|branch|account|connection|workspace|org|organization|tenant|destination|target)(?:address(?:es)?|names?|slug|key)$/.test(
			name.toLowerCase(),
		) ||
		["email", "uri", "uri-reference", "uuid"].includes(String(schema.format))
	);
}

export type ApprovalEditableFieldKind =
	| "text"
	| "long_text"
	| "number"
	| "integer"
	| "boolean"
	| "choice";

function scalarType(schema: Record<string, unknown>): string | null {
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.every(
			(value) => typeof value === "string" || typeof value === "number",
		)
			? "enum"
			: null;
	}
	const type = Array.isArray(schema.type)
		? schema.type.filter((entry) => entry !== "null")
		: [schema.type];
	if (type.length !== 1) return null;
	const [only] = type;
	return typeof only === "string" && SCALAR_TYPES.has(only) ? only : null;
}

/** The input control a field needs. Null for a non-scalar schema. */
export function approvalEditableFieldKind(
	field: Pick<ApprovalEditableField, "name" | "schema">,
): ApprovalEditableFieldKind | null {
	const type = scalarType(field.schema);
	if (type === "enum") return "choice";
	if (type === "number" || type === "integer" || type === "boolean")
		return type;
	if (type !== "string") return null;
	const maxLength = field.schema.maxLength;
	return (typeof maxLength === "number" && maxLength > 200) ||
		(typeof maxLength !== "number" &&
			/(?:body|content|description|message|text|markdown|notes?)$/i.test(
				field.name,
			))
		? "long_text"
		: "text";
}

function labelFor(name: string, schema: Record<string, unknown>): string {
	if (typeof schema.title === "string" && schema.title.trim())
		return schema.title.trim().slice(0, 120);
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 120);
}

/**
 * Editable fields for one tool call, in input-schema order.
 *
 * `declared` is the tool's configured list (an empty list turns edits off);
 * `pinned` are tenant-configured defaults, which always win and are never
 * editable.
 */
export function deriveApprovalEditableFields(input: {
	inputSchema:
		| { properties?: Record<string, unknown>; required?: string[] }
		| null
		| undefined;
	declared?: readonly string[] | null;
	pinned?: readonly string[];
}): ApprovalEditableField[] {
	const properties = input.inputSchema?.properties ?? {};
	const required = new Set(input.inputSchema?.required ?? []);
	const pinned = new Set(input.pinned ?? []);
	const names = input.declared ?? Object.keys(properties);
	const fields: ApprovalEditableField[] = [];
	for (const name of names) {
		if (fields.length >= MAX_APPROVAL_EDITABLE_FIELDS) break;
		const schema = properties[name];
		if (pinned.has(name) || !isRecord(schema) || !scalarType(schema)) continue;
		if (input.declared == null && destinationLikeInput(name, schema)) continue;
		let serialized: string;
		try {
			serialized = JSON.stringify(schema);
		} catch {
			continue;
		}
		if (serialized.length > MAX_PROPERTY_SCHEMA_LENGTH) continue;
		const description =
			typeof schema.description === "string" && schema.description.trim()
				? schema.description.trim().slice(0, 500)
				: undefined;
		fields.push({
			name,
			label: labelFor(name, schema),
			...(description ? { description } : {}),
			required: required.has(name),
			schema: JSON.parse(serialized) as Record<string, JsonValue>,
		});
	}
	return fields;
}

export type ApplyApprovalEditsResult =
	| {
			ok: true;
			args: Record<string, unknown>;
			changes: ApprovalFieldChange[];
	  }
	| { ok: false; error: string };

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Apply approver edits to the stored arguments. Every edited key must be a
 * declared field and every value must satisfy that field's tool schema.
 * Unchanged values are dropped, so an untouched form records no changes.
 */
export function applyApprovalEdits(input: {
	fields: readonly ApprovalEditableField[];
	args: Record<string, unknown>;
	edits: Record<string, unknown>;
}): ApplyApprovalEditsResult {
	const byName = new Map(input.fields.map((field) => [field.name, field]));
	const args = { ...input.args };
	const changes: ApprovalFieldChange[] = [];
	for (const [name, value] of Object.entries(input.edits)) {
		const field = byName.get(name);
		if (!field) return { ok: false, error: `"${name}" cannot be changed` };
		if (sameValue(args[name], value)) continue;
		if (value === null || value === "") {
			if (field.required)
				return { ok: false, error: `${field.label} is required` };
			const before = (args[name] ?? null) as JsonValue;
			delete args[name];
			if (before !== null) changes.push({ field: name, before, after: null });
			continue;
		}
		if (JSON.stringify(value).length > MAX_EDIT_VALUE_LENGTH)
			return { ok: false, error: `${field.label} is too long` };
		let valid = false;
		try {
			valid = z
				.fromJSONSchema(field.schema as Parameters<typeof z.fromJSONSchema>[0])
				.safeParse(value).success;
		} catch {
			valid = false;
		}
		if (!valid)
			return {
				ok: false,
				error: `${field.label} does not match what this action accepts`,
			};
		changes.push({
			field: name,
			before: (args[name] ?? null) as JsonValue,
			after: value as JsonValue,
		});
		args[name] = value;
	}
	return { ok: true, args, changes };
}

/** The editable fields a stored approval payload declares, or none. */
export function approvalPayloadEditableFields(
	payload: Record<string, unknown> | null | undefined,
): ApprovalEditableField[] {
	const parsed = ApprovalEditableFieldsSchema.safeParse(
		payload?.editableFields,
	);
	return parsed.success && isRecord(payload?.args) ? parsed.data : [];
}

export type ApplyApproverEditsResult =
	| {
			ok: true;
			payload: Record<string, JsonValue>;
			changes: ApprovalFieldChange[];
	  }
	| { ok: false; error: string };

/**
 * Apply approver edits to a stored approval payload: replace `args` and record
 * who changed what on the payload itself. No changes returns the payload as is.
 */
export function applyApproverEditsToPayload(input: {
	payload: Record<string, JsonValue>;
	edits: Record<string, unknown>;
	editedBy: string;
	editedAt: string;
}): ApplyApproverEditsResult {
	const fields = approvalPayloadEditableFields(input.payload);
	if (!fields.length)
		return { ok: false, error: "This request has no fields you can change" };
	const applied = applyApprovalEdits({
		fields,
		args: input.payload.args as Record<string, unknown>,
		edits: input.edits,
	});
	if (!applied.ok) return applied;
	if (!applied.changes.length)
		return { ok: true, payload: input.payload, changes: [] };
	const approverEdits: ApproverEditsRecord = {
		editedBy: input.editedBy,
		editedAt: input.editedAt,
		changes: applied.changes,
	};
	return {
		ok: true,
		payload: {
			...input.payload,
			args: applied.args as Record<string, JsonValue>,
			approverEdits,
		},
		changes: applied.changes,
	};
}
