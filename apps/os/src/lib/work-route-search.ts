export function workQueueSearch(search: Record<string, unknown>): {
	disposition?: "completed";
} {
	return search.disposition === "completed" ? { disposition: "completed" } : {};
}

export function workCapacitySearch(search: Record<string, unknown>) {
	const resourceKey =
		typeof search.resourceKey === "string" &&
		search.resourceKey.length > 0 &&
		search.resourceKey.length <= 300
			? search.resourceKey
			: undefined;
	const explicit =
		search.saturated === true || search.saturated === "true"
			? true
			: search.saturated === false || search.saturated === "false"
				? false
				: undefined;
	return {
		resourceKey,
		saturated: explicit ?? !resourceKey,
		view:
			search.view === "budgets" ? ("budgets" as const) : ("resources" as const),
		exhausted: search.exhausted === true || search.exhausted === "true",
	};
}

export function workInteractionsSearch(search: Record<string, unknown>): {
	view: "inbox" | "outbox" | "audit";
	state: "open" | "all";
} {
	return {
		view:
			search.view === "outbox" || search.view === "audit"
				? search.view
				: ("inbox" as const),
		state: search.state === "open" ? ("open" as const) : ("all" as const),
	};
}
