import {
	PersonalResourceToolBindingSchema,
	type PersonalResourceToolBinding,
} from "../schemas/tools";
import type { OsDerivedAccessEnvelope } from "../schemas/os-workspaces";
import {
	PERSONAL_ORGANISE_OPERATION,
	SCOPE_IMPLICATION_PROFILES,
	personalAccountCapabilityProfile,
} from "./provider-capability-profiles";
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
/** What a person lets a worker do with their connected account: nothing, read, or read and organise. */
export type PersonalAccessLevel = "none" | "read" | "organise";
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
/** True when a delegated call would make an allowed tool destructive (e.g. Gmail label to Trash). */
export function forbiddenPersonalToolArguments(
	providerId: string,
	toolName: string,
	args: unknown,
): boolean {
	const guard =
		personalAccountCapabilityProfile(providerId)?.forbiddenArguments;
	if (!guard?.tools.includes(toolName)) return false;
	if (typeof args !== "object" || args === null) return false;
	return guard.keys.some((key) => {
		const value = Object.hasOwn(args, key)
			? (args as Record<string, unknown>)[key]
			: undefined;
		return (
			value !== undefined &&
			(!Array.isArray(value) ||
				value.some(
					(id) =>
						typeof id !== "string" || guard.values.has(id.trim().toUpperCase()),
				))
		);
	});
}
/** What people call a reviewed account, for consent copy ("read my Gmail"). */
export function reviewedPersonalAccountName(
	providerId: string,
): string | undefined {
	return personalAccountCapabilityProfile(providerId)?.displayName;
}
export function reviewedPersonalResourceBinding(
	providerId: string,
	providerToolName: unknown,
): PersonalResourceToolBinding | undefined {
	if (typeof providerToolName !== "string") return undefined;
	const tools = personalAccountCapabilityProfile(providerId)?.accountTools;
	return tools && Object.hasOwn(tools, providerToolName)
		? tools[providerToolName]
		: undefined;
}
/**
 * The binding a delegated call runs under. An installed tool may map its own
 * resource arguments (`paths`), which only narrows to admitted resources. An
 * account-wide binding names no resource, so only the reviewed profile may
 * grant one: a tenant row cannot turn send or delete into a "read".
 */
export function effectivePersonalResourceBinding(
	providerId: string,
	providerToolName: unknown,
	installedBinding: unknown,
): PersonalResourceToolBinding | undefined {
	const reviewed = reviewedPersonalResourceBinding(
		providerId,
		providerToolName,
	);
	if (installedBinding === undefined || installedBinding === null)
		return reviewed;
	const parsed = PersonalResourceToolBindingSchema.safeParse(installedBinding);
	if (!parsed.success) return undefined;
	if (!("target" in parsed.data)) return parsed.data;
	return reviewed &&
		"target" in reviewed &&
		reviewed.operation === parsed.data.operation &&
		reviewed.resourceType === parsed.data.resourceType
		? reviewed
		: undefined;
}
/** App-wide OAuth scopes can include writes that a reviewed read tool never needs. */
export function reviewedPersonalResourceReadScopes(
	providerId: string,
	providerToolName: unknown,
): string[] | undefined {
	if (
		reviewedPersonalResourceBinding(providerId, providerToolName)?.operation !==
		"read"
	)
		return undefined;
	const scopes = personalAccountCapabilityProfile(providerId)?.readScopes;
	return scopes?.length ? [...scopes] : undefined;
}
/** Provider-documented scope implications only; never turns a read grant into write authority. */
export function personalResourceScopesCover(
	granted: readonly string[],
	required: readonly string[],
): boolean {
	// Whole-scope identity only: a scope is an opaque provider string, never a
	// URL whose host or path we trust by prefix.
	const has = new Set(granted);
	return required.every(
		(scope) =>
			has.has(scope) ||
			SCOPE_IMPLICATION_PROFILES.some((profile) =>
				profile.implications.some(
					(rule) => has.has(rule.granted) && rule.covers.includes(scope),
				),
			),
	);
}
