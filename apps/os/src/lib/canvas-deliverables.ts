import type { OsOutputLibraryItem } from "@tedix/api-contract/schemas/os-workspaces";

/**
 * Deliverable classification for the Canvas resource rail.
 *
 * The rail used to equate "video" with "deliverable" and dump every other kind
 * into the history group, so a document-only workspace could never show a
 * current deliverable and every reference doc was filed as an "earlier
 * candidate". Delivery state is a property of the output's quality gate, not of
 * its media kind: an output either carries a delivery envelope (it went through
 * the gate) or it is a reference artifact that was never gated.
 *
 * Everything here is pure over the library rows the shell already caches.
 */

export type DeliveryState = "approved" | "candidate" | "rejected" | "reference";

export type OutputStateFilter = "active" | "archived" | "all";

/** The delivery envelope, present only on gated output kinds. */
type DeliveryEnvelope = {
	status: "candidate" | "approved" | "rejected";
	verdict?: "pass" | "revise" | "reject";
	score?: number;
};

export function outputDelivery(
	item: OsOutputLibraryItem,
): DeliveryEnvelope | null {
	return item.preview.kind === "video" ? (item.preview.delivery ?? null) : null;
}

/**
 * An output that never went through the quality gate is a reference artifact,
 * not a failed candidate. A gated output reports whatever the gate decided.
 */
export function deliveryState(item: OsOutputLibraryItem): DeliveryState {
	return outputDelivery(item)?.status ?? "reference";
}

/**
 * Newest first by the output's own timestamp. The previous rail took
 * `candidates[0]`, which made "latest" an accident of server list order.
 */
export function byUpdatedAtDesc(
	left: OsOutputLibraryItem,
	right: OsOutputLibraryItem,
): number {
	const l = Date.parse(left.output.updatedAt);
	const r = Date.parse(right.output.updatedAt);
	if (Number.isNaN(l) && Number.isNaN(r)) return 0;
	if (Number.isNaN(l)) return 1;
	if (Number.isNaN(r)) return -1;
	return r - l;
}

export function matchesStateFilter(
	item: OsOutputLibraryItem,
	filter: OutputStateFilter,
): boolean {
	return filter === "all" ? true : item.output.status === filter;
}

/**
 * Counts for the state chips. Each count honors the *search* but ignores the
 * state filter itself, so the numbers on the chips always sum to the "All"
 * chip and never mislead about what switching would reveal.
 */
export function outputStateCounts(items: readonly OsOutputLibraryItem[]): {
	active: number;
	archived: number;
	all: number;
} {
	let active = 0;
	let archived = 0;
	for (const item of items) {
		if (item.output.status === "active") active += 1;
		else if (item.output.status === "archived") archived += 1;
	}
	return { active, archived, all: items.length };
}

export type DeliverableGroups = {
	/** The one output the quality gate approved, if any. */
	approved: OsOutputLibraryItem | null;
	/** Newest gated output that is not the approved one. */
	latestCandidate: OsOutputLibraryItem | null;
	/** Older gated outputs, newest first. */
	earlierIterations: OsOutputLibraryItem[];
	/** Never-gated artifacts (briefs, specs, notes), newest first. */
	references: OsOutputLibraryItem[];
};

/**
 * Group library rows into the four things a reader actually asks for: what is
 * approved, what is the newest attempt, what came before it, and what is
 * supporting material.
 */
export function groupDeliverables(
	items: readonly OsOutputLibraryItem[],
): DeliverableGroups {
	const sorted = [...items].sort(byUpdatedAtDesc);
	const gated: OsOutputLibraryItem[] = [];
	const references: OsOutputLibraryItem[] = [];
	let approved: OsOutputLibraryItem | null = null;

	for (const item of sorted) {
		const state = deliveryState(item);
		if (state === "reference") {
			references.push(item);
			continue;
		}
		// Sorted newest-first, so the first approved row wins and any older
		// approved output falls back into the iteration history.
		if (state === "approved" && approved === null) {
			approved = item;
			continue;
		}
		gated.push(item);
	}

	return {
		approved,
		latestCandidate: gated[0] ?? null,
		earlierIterations: gated.slice(1),
		references,
	};
}

/** Short badge text for a row: the verdict and score when the gate emitted them. */
export function deliveryBadgeLabel(item: OsOutputLibraryItem): string {
	const delivery = outputDelivery(item);
	if (!delivery) return item.output.kind;
	const verdict = delivery.verdict ?? delivery.status;
	return delivery.score === undefined
		? verdict
		: `${verdict} · ${Math.round(delivery.score)}`;
}
