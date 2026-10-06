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
	const googleRoot = "https://www.googleapis.com/auth/calendar";
	const googleFamily = new Set([
		googleRoot,
		`${googleRoot}.readonly`,
		`${googleRoot}.events`,
		`${googleRoot}.events.readonly`,
		`${googleRoot}.calendarlist.readonly`,
	]);
	return required.every(
		(scope) =>
			granted.includes(scope) ||
			(googleFamily.has(scope) && granted.includes(googleRoot)) ||
			(scope === `${googleRoot}.events.readonly` &&
				granted.includes(`${googleRoot}.events`)) ||
			((scope === `${googleRoot}.calendarlist.readonly` ||
				scope === `${googleRoot}.events.readonly`) &&
				granted.includes(`${googleRoot}.readonly`)) ||
			((scope === "Calendars.Read" ||
				scope === "https://graph.microsoft.com/Calendars.Read") &&
				granted.some(
					(value) =>
						value === "Calendars.ReadWrite" ||
						value === "https://graph.microsoft.com/Calendars.ReadWrite",
				)),
	);
}
