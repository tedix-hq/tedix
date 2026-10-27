import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import {
	cellText,
	columnIndex,
	firstLink,
	type ReviewCard,
	type SheetBody,
} from "@tedix/api-contract/utils/card-review";

/** Build replay inputs without changing any sheet cells. */
export function cardReplayParams(
	replay: NonNullable<CardReviewSource["replay"]>,
	cards: readonly ReviewCard[],
	body: SheetBody,
) {
	if (cards.length === 0 || cards.length > 200)
		throw new Error("Select between 1 and 200 cards from one sheet.");
	if (new Set(cards.map((card) => card.outputId)).size !== 1)
		throw new Error("Select cards from one sheet at a time.");
	const indices = Object.fromEntries(
		Object.entries(replay.columns).map(([key, name]) => {
			const index = columnIndex(body.columns, name);
			if (index < 0) throw new Error(`This sheet is missing ${name}.`);
			return [key, index];
		}),
	);
	const urls = new Set<string>();
	const items = cards.map((card) => {
		const row = body.rows[card.rowIndex];
		const url = firstLink(cellText(row?.[indices.url!]));
		// A concurrent row insertion/reorder must not re-score another card.
		if (!url || url !== card.link)
			throw new Error(
				"The selected cards changed. Reload the sheet and select them again.",
			);
		if (urls.has(url)) throw new Error("Selected cards have duplicate URLs.");
		urls.add(url);
		return {
			url,
			title: cellText(row?.[indices.title!]),
			text: cellText(row?.[indices.text!]),
		};
	});
	return { mode: "replay", items };
}
