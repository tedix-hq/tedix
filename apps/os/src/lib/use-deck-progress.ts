import { useLayoutEffect, useState } from "react";

type ProgressCard = {
	id: string;
	kind: string;
	askKind: string;
	draftedNotSent: boolean;
	project: string;
	urgency: string;
	label: string;
};

/** Retain filter metadata when optimistic decisions remove cards from the cache. */
export function useDeckProgress(
	key: string,
	cards: ProgressCard[],
	matches: (card: ProgressCard) => boolean,
	remaining: number,
) {
	const [saved, setSaved] = useState<{ key: string; cards: ProgressCard[] }>({
		key,
		cards: [],
	});
	const candidates = new Map(
		(saved.key === key ? saved.cards : []).map((card) => [card.id, card]),
	);
	for (const card of cards) candidates.set(card.id, card);
	const encoded = JSON.stringify(
		[...candidates.values()].map(
			({ id, kind, askKind, draftedNotSent, project, urgency, label }) => ({
				id,
				kind,
				askKind,
				draftedNotSent,
				project,
				urgency,
				label,
			}),
		),
	);
	useLayoutEffect(() => {
		setSaved({ key, cards: JSON.parse(encoded) as ProgressCard[] });
	}, [key, encoded]);
	const total = [...candidates.values()].filter(matches).length;
	return { total, completed: Math.max(0, total - remaining) };
}
