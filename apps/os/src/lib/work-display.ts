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

export function factoryHref(
	row: Pick<FactoryScoreboardEntry, "kind" | "id">,
): string {
	return row.kind === "blueprint" ? "/blueprints" : `/skills/${row.id}/runs`;
}
