import {
	PersonalResourceToolBindingSchema,
	type PersonalResourceToolBinding,
} from "../schemas/tools";
import type { OsDerivedAccessEnvelope } from "../schemas/os-workspaces";
/** Unknown mappings, malformed arrays and cross-account batches are denied before credentials or transport. */
export function constrainPersonalResourceToolArguments(input: {
	binding: unknown;
	arguments: unknown;
	sources: OsDerivedAccessEnvelope["sources"];
	providerId: string;
	toolId: string;
	/** The upstream tool name, when it differs from the installed tool id. */
	providerToolName?: string;
}) {
	const binding = PersonalResourceToolBindingSchema.parse(input.binding);
	const denied = () => {
		throw new Error(
			"Provider arguments escape the exact admitted personal resources",
		);
	};
	const encoded = JSON.stringify(input.arguments);
	if (!encoded || encoded.length > 100000) denied();
	for (const name of [input.toolId, input.providerToolName])
		if (
			name &&
			forbiddenPersonalToolArguments(input.providerId, name, input.arguments)
		)
			denied();
	function values(value: unknown, path: string[]): string[] {
		if (!path.length) {
			if (typeof value !== "string" || !value.trim()) return denied();
			return [value];
		}
		const [key, ...tail] = path;
		if (key === "*") {
			if (!Array.isArray(value) || !value.length || value.length > 50)
				return denied();
			return value.flatMap((item) => values(item, tail));
		}
		if (
			!key ||
			["__proto__", "constructor", "prototype"].includes(key) ||
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!Object.hasOwn(value, key)
		)
			return denied();
		return values((value as Record<string, unknown>)[key], tail);
	}
	const admitted = (source: OsDerivedAccessEnvelope["sources"][number]) =>
		source.connectionScope === "user" &&
		source.providerId === input.providerId &&
		source.resourceType === binding.resourceType &&
		source.operations.includes(binding.operation) &&
		Boolean(source.toolIds?.includes(input.toolId));
	let matches: OsDerivedAccessEnvelope["sources"];
	if ("target" in binding) {
		// The tool names no resource: it acts on the connected account itself, so
		// exactly one admitted account resource may back it.
		if (
			typeof input.arguments !== "object" ||
			input.arguments === null ||
			Array.isArray(input.arguments)
		)
			denied();
		const matching = input.sources.filter(admitted);
		if (matching.length !== 1) denied();
		matches = matching;
	} else {
		const ids = [
			...new Set(
				binding.paths.flatMap((path) => values(input.arguments, path)),
			),
		];
		matches = ids.map((id) => {
			const matching = input.sources.filter(
				(source) => admitted(source) && source.providerResourceId === id,
			);
			if (matching.length !== 1) return denied();
			return matching[0]!;
		});
	}
	const first = matches[0];
	if (
		!first ||
		matches.some(
			(source) =>
				source.connectionInstanceId !== first.connectionInstanceId ||
				source.personalOwnerUserId !== first.personalOwnerUserId,
		)
	)
		denied();
	return { operation: binding.operation, sources: matches };
}
/**
 * How much a person lets a worker do with their connected account, chosen on
 * the account's row in a Workspace: nothing, read, or read and organise.
 * Organising (operation `modify`) labels, archives, marks read and drafts; no
 * reviewed tool sends, trashes, marks spam or deletes.
 */
export type PersonalAccessLevel = "none" | "read" | "organise";
export const PERSONAL_ORGANISE_OPERATION = "modify";
export function personalAccessOperations(level: PersonalAccessLevel): string[] {
	if (level === "organise") return ["read", PERSONAL_ORGANISE_OPERATION];
	return level === "read" ? ["read"] : [];
}
/** The level a consent's operations amount to. */
export function personalAccessLevel(
	operations: readonly string[],
): PersonalAccessLevel {
	if (operations.includes(PERSONAL_ORGANISE_OPERATION)) return "organise";
	return operations.includes("read") ? "read" : "none";
}
const onAccount = (operation: string): PersonalResourceToolBinding => ({
	operation,
	resourceType: "mailbox",
	target: "account",
});
/**
 * Server-reviewed bindings for provider tools that act on the connected account
 * and take no resource argument. A consent can never reach a tool absent here:
 * Gmail's send, trash, spam and delete tools are deliberately missing.
 */
const REVIEWED_ACCOUNT_BINDINGS: Readonly<
	Record<string, Readonly<Record<string, PersonalResourceToolBinding>>>
> = {
	"google-gmail": {
		...Object.fromEntries(
			["search_threads", "get_thread", "get_message", "list_labels"].map(
				(tool) => [tool, onAccount("read")],
			),
		),
		...Object.fromEntries(
			["label_thread", "unlabel_thread", "create_label", "create_draft"].map(
				(tool) => [tool, onAccount(PERSONAL_ORGANISE_OPERATION)],
			),
		),
	},
	"google-calendar": {
		list_events: {
			operation: "read",
			resourceType: "calendar_account",
			target: "account",
		},
	},
};
/**
 * Adding Trash or Spam is how a label tool deletes mail, so no delegated call
 * may add them, whatever binding the installed tool carries.
 */
const FORBIDDEN_LABEL_IDS = new Set(["TRASH", "SPAM"]);
const LABEL_ADDING_TOOLS: Readonly<Record<string, readonly string[]>> = {
	"google-gmail": ["label_thread", "label_message", "update_message_labels"],
};
/** True when a delegated call would make an account tool delete mail. */
export function forbiddenPersonalToolArguments(
	providerId: string,
	toolName: string,
	args: unknown,
): boolean {
	const tools = Object.hasOwn(LABEL_ADDING_TOOLS, providerId)
		? LABEL_ADDING_TOOLS[providerId]!
		: [];
	if (!tools.includes(toolName)) return false;
	if (typeof args !== "object" || args === null) return false;
	return ["labelIds", "addLabelIds"].some((key) => {
		const value = Object.hasOwn(args, key)
			? (args as Record<string, unknown>)[key]
			: undefined;
		return (
			value !== undefined &&
			(!Array.isArray(value) ||
				value.some(
					(id) =>
						typeof id !== "string" ||
						FORBIDDEN_LABEL_IDS.has(id.trim().toUpperCase()),
				))
		);
	});
}
/** What people call a reviewed account, for consent copy ("read my Gmail"). */
const REVIEWED_ACCOUNT_NAMES: Readonly<Record<string, string>> = {
	"google-gmail": "Gmail",
	"google-calendar": "Calendar",
};
export function reviewedPersonalAccountName(
	providerId: string,
): string | undefined {
	return Object.hasOwn(REVIEWED_ACCOUNT_NAMES, providerId)
		? REVIEWED_ACCOUNT_NAMES[providerId]
		: undefined;
}
export function reviewedPersonalResourceBinding(
	providerId: string,
	providerToolName: unknown,
): PersonalResourceToolBinding | undefined {
	if (typeof providerToolName !== "string") return undefined;
	const tools = REVIEWED_ACCOUNT_BINDINGS[providerId];
	return tools && Object.hasOwn(tools, providerToolName)
		? tools[providerToolName]
		: undefined;
}
/** App-wide OAuth scopes can include writes that a reviewed read tool never needs. */
export function reviewedPersonalResourceReadScopes(
	providerId: string,
	providerToolName: unknown,
): string[] | undefined {
	if (
		providerId === "google-gmail" &&
		reviewedPersonalResourceBinding(providerId, providerToolName)?.operation ===
			"read"
	)
		return ["https://www.googleapis.com/auth/gmail.readonly"];
	if (providerId === "google-calendar" && providerToolName === "list_events")
		return ["https://www.googleapis.com/auth/calendar.events.readonly"];
	return undefined;
}
/** Provider-documented scope implications only; never turns a read grant into write authority. */
export function personalResourceScopesCover(
	granted: readonly string[],
	required: readonly string[],
): boolean {
	// Whole-scope identity only: a scope is an opaque provider string, never a
	// URL whose host or path we trust by prefix.
	const has = new Set(granted);
	const googleRoot = GOOGLE_CALENDAR_SCOPE_ROOT;
	return required.every(
		(scope) =>
			has.has(scope) ||
			(GOOGLE_CALENDAR_SCOPE_FAMILY.has(scope) && has.has(googleRoot)) ||
			(scope === `${googleRoot}.events.readonly` &&
				has.has(`${googleRoot}.events`)) ||
			((scope === `${googleRoot}.calendarlist.readonly` ||
				scope === `${googleRoot}.events.readonly`) &&
				has.has(`${googleRoot}.readonly`)) ||
			((scope === "Calendars.Read" ||
				scope === "https://graph.microsoft.com/Calendars.Read") &&
				(has.has("Calendars.ReadWrite") ||
					has.has("https://graph.microsoft.com/Calendars.ReadWrite"))),
	);
}
export const GOOGLE_CALENDAR_SCOPE_ROOT =
	"https://www.googleapis.com/auth/calendar";
/** Every Google Calendar scope the root scope implies, by exact identity. */
export const GOOGLE_CALENDAR_SCOPE_FAMILY: ReadonlySet<string> = new Set([
	GOOGLE_CALENDAR_SCOPE_ROOT,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.readonly`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.events.readonly`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.calendarlist.readonly`,
]);
