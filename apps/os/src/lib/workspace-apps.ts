import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import type {
	OsGadget,
	OsGadgetManifest,
	OsOutput,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	cardSheetsForSource,
	cardsFromSheet,
	type ReviewCard,
	reviewQueue,
	scoredCards,
	type SheetBody,
} from "@tedix/api-contract/utils/card-review";

/**
 * How a workspace app introduces itself on its card in the Resources pane:
 * the manifest's one-line purpose wins (it is versioned with the app), then
 * the record's description, then a purpose derived from the app's settings.
 */
export function appPurpose(
	gadget: Pick<OsGadget, "description">,
	manifest: OsGadgetManifest | null | undefined,
	cardReview: CardReviewConfig | null,
): string | null {
	const declared = manifest?.description?.trim() || gadget.description?.trim();
	if (declared) return declared;
	if (cardReview) {
		const labels = [...new Set(cardReview.sources.map((s) => s.label))];
		return `Decide on today's ${joinWithAnd(labels)} cards`;
	}
	return null;
}

function joinWithAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What kind of app an entry selects, in words a person reading the card understands. */
export function appKindLabel(
	manifest: OsGadgetManifest | null | undefined,
): string | null {
	const entry = manifest?.entry.trim() ?? "";
	if (entry.startsWith("tedix:app/")) return "Built-in app";
	if (entry.startsWith("ui://")) return "Interactive app";
	if (manifest?.skillSlug || /^[a-z0-9][a-z0-9-]*$/.test(entry))
		return "Runs a skill";
	return null;
}

/**
 * The open cards a Card review app would show right now, without per-viewer
 * snoozes or skips: the count for the app's status line and the next card for
 * its preview.
 */
export function cardReviewSummary(
	config: CardReviewConfig,
	outputLists: readonly (
		| readonly Pick<
				OsOutput,
				"id" | "title" | "kind" | "status" | "createdAt"
		  >[]
		| undefined
	)[],
	sheets: ReadonlyMap<string, SheetBody>,
): { waiting: number; next: ReviewCard | null } | null {
	const cards: ReviewCard[] = [];
	for (const [sourceIndex, source] of config.sources.entries()) {
		const items = outputLists[sourceIndex];
		if (!items) return null;
		for (const sheet of cardSheetsForSource(source, items)) {
			const body = sheets.get(sheet.id);
			if (!body) return null;
			const result = cardsFromSheet({
				source,
				sourceIndex,
				outputId: sheet.id,
				sheetTitle: sheet.title,
				runCreatedAt: sheet.createdAt,
				body,
			});
			if ("cards" in result) cards.push(...result.cards);
		}
	}
	const queue = reviewQueue(scoredCards(cards, config.sources), {
		channel: null,
		snoozes: {},
		skipped: [],
		now: new Date(0),
	});
	return { waiting: queue.length, next: queue[0] ?? null };
}

export function cardsWaitingLabel(waiting: number): string {
	if (waiting === 0) return "No cards waiting";
	return waiting === 1 ? "1 card waiting" : `${waiting} cards waiting`;
}
