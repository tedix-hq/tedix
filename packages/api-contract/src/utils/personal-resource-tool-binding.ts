import { PersonalResourceToolBindingSchema } from "../schemas/tools";
import type { OsDerivedAccessEnvelope } from "../schemas/os-workspaces";
/** Unknown mappings, malformed arrays and cross-account batches are denied before credentials or transport. */
export function constrainPersonalResourceToolArguments(input: {
	binding: unknown;
	arguments: unknown;
	sources: OsDerivedAccessEnvelope["sources"];
	providerId: string;
	toolId: string;
}) {
	const binding = PersonalResourceToolBindingSchema.parse(input.binding);
	const denied = () => {
		throw new Error(
			"Provider arguments escape the exact admitted personal resources",
		);
	};
	const encoded = JSON.stringify(input.arguments);
	if (!encoded || encoded.length > 100000) denied();
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
	const ids = [
		...new Set(binding.paths.flatMap((path) => values(input.arguments, path))),
	];
	const matches = ids.map((id) => {
		const matching = input.sources.filter(
			(source) =>
				source.connectionScope === "user" &&
				source.providerId === input.providerId &&
				source.resourceType === binding.resourceType &&
				source.providerResourceId === id &&
				source.operations.includes(binding.operation) &&
				source.toolIds?.includes(input.toolId),
		);
		if (matching.length !== 1) return denied();
		return matching[0]!;
	});
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
