import type { FactoryScoreboardEntry } from "@tedix/api-contract/contracts/projects";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

/**
 * Keep human-readable principals intact while quieting opaque UUIDs in dense
 * Work lists. Callers retain the canonical value for title and data semantics.
 */
export function workPrincipalLabel(
	value: string | null,
	type?: string,
): string {
	const identity = value
		? UUID_PATTERN.test(value)
			? `${value.slice(0, 8)}…`
			: value
		: "Unassigned";
	return type ? `${type}:${identity}` : identity;
}

/**
 * Hover text for a principal: the person's, tedi's or agent's name when known,
 * otherwise only the kind ("Tedi"). Never the raw `type:uuid` pair.
 */
export function workPrincipalTooltip(
	type: string | undefined,
	id: string | null | undefined,
	names?: ReadonlyMap<string, string>,
): string {
	const known = names?.get(`${type}:${id}`);
	if (known) return known;
	if (!type) return "Unknown";
	const kind = type === "external_agent" ? "agent" : type;
	return `${kind.charAt(0).toUpperCase()}${kind.slice(1).replaceAll("_", " ")}`;
}

export function factoryHref(
	row: Pick<FactoryScoreboardEntry, "kind" | "id">,
): string {
	return row.kind === "blueprint" ? "/blueprints" : `/skills/${row.id}/runs`;
}
