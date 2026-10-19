const firstViews = new Map<string, number>();
const detailsViews = new Set<string>();

export function markCardDetails(key: string) {
	if (detailsViews.size >= 5000)
		detailsViews.delete(detailsViews.values().next().value!);
	detailsViews.add(key);
	try {
		localStorage.setItem(`tedix:card-details:${key}`, "opened");
	} catch {}
}

export function cardDetailsOpened(key: string | null): boolean {
	if (!key) return false;
	if (detailsViews.has(key)) return true;
	try {
		return localStorage.getItem(`tedix:card-details:${key}`) === "opened";
	} catch {
		return false;
	}
}

export function readCardFirstView(
	key: string,
	now = Date.now(),
): number | undefined {
	const inMemory = firstViews.get(key);
	if (inMemory && inMemory <= now) return inMemory;
	try {
		const stored = Number(localStorage.getItem(`tedix:card-first-view:${key}`));
		if (Number.isFinite(stored) && stored > 0 && stored <= now) return stored;
	} catch {
		// An embedded browser may deny storage; the current visit still has an in-memory clock.
	}
	return undefined;
}

/** Persist the first view across navigation and reloads, scoped to person and source version. */
export function cardFirstView(key: string, now = Date.now()): number {
	const first = readCardFirstView(key, now) ?? now;
	if (firstViews.size >= 5000)
		firstViews.delete(firstViews.keys().next().value!);
	firstViews.set(key, first);
	try {
		localStorage.setItem(`tedix:card-first-view:${key}`, String(first));
	} catch {}
	return first;
}

export function cardDecisionTiming(
	key: string | null,
	decidedAt = Date.now(),
): { firstViewedAt?: number; elapsedMs?: number } {
	const firstViewedAt = key ? readCardFirstView(key, decidedAt) : undefined;
	return firstViewedAt === undefined
		? {}
		: { firstViewedAt, elapsedMs: Math.max(0, decidedAt - firstViewedAt) };
}
