/** Where a Deck or Feed card came from: a factory in a workspace, or null for Work itself. */
export type CardOrigin = { factory: string; workspaceId: string } | null;

export const ALL_CARD_SOURCES = "all";
const WORK = "app:work";

/**
 * Source filter choices: Work, then each factory by its label, then each
 * workspace that holds a factory. Nothing to choose without a factory.
 */
export function cardSourceOptions(
	factories: readonly { label: string; workspaceId: string }[],
	workspaceName: (id: string) => string | undefined,
): { value: string; label: string }[] {
	if (factories.length === 0) return [];
	const labels = [...new Set(factories.map((source) => source.label))];
	const spaces = [...new Set(factories.map((source) => source.workspaceId))];
	return [
		{ value: ALL_CARD_SOURCES, label: "All sources" },
		{ value: WORK, label: "Work" },
		...labels.map((label) => ({ value: `factory:${label}`, label })),
		...spaces.map((id) => ({
			value: `workspace:${id}`,
			label: `In ${workspaceName(id) ?? "a workspace"}`,
		})),
	];
}

export function matchesCardSource(value: string, origin: CardOrigin) {
	if (value === ALL_CARD_SOURCES) return true;
	if (value === WORK) return origin === null;
	if (value.startsWith("factory:"))
		return origin?.factory === value.slice("factory:".length);
	if (value.startsWith("workspace:"))
		return origin?.workspaceId === value.slice("workspace:".length);
	return true;
}
