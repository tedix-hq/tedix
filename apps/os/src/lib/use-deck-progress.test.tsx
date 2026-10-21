import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { useDeckProgress } from "./use-deck-progress";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ProgressCard = Parameters<typeof useDeckProgress>[1][number];
const answer: ProgressCard = {
	id: "answer",
	kind: "question",
	askKind: "answer",
	draftedNotSent: false,
	project: "orchard",
	urgency: "normal",
	label: "Review the proposal",
};
const outbound: ProgressCard = {
	...answer,
	id: "outbound",
	askKind: "send",
	draftedNotSent: true,
	label: "Send the draft",
};
const filters = [
	{
		name: "ask-kind",
		matches: (card: ProgressCard) => card.askKind === "answer",
	},
	{
		name: "drafted-not-sent",
		matches: (card: ProgressCard) => card.draftedNotSent,
	},
];
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

function Preview({
	scope,
	cards,
	matches,
	remaining,
}: {
	scope: string;
	cards: ProgressCard[];
	matches: (card: ProgressCard) => boolean;
	remaining: number;
}) {
	const progress = useDeckProgress(scope, cards, matches, remaining);
	return <output>{JSON.stringify(progress)}</output>;
}

async function render(
	cards: ProgressCard[],
	matches: (card: ProgressCard) => boolean,
	remaining: number,
	scope = "workspace:person:decide",
) {
	await act(async () =>
		root.render(
			<Preview
				scope={scope}
				cards={cards}
				matches={matches}
				remaining={remaining}
			/>,
		),
	);
	return JSON.parse(host.querySelector("output")!.textContent!);
}

it.each(filters)(
	"retains $name progress through optimistic removal and zero remaining",
	async ({ matches }) => {
		const cards = [answer, outbound];
		expect(await render(cards, matches, 1)).toEqual({ total: 1, completed: 0 });
		const remainingCards = cards.filter((card) => !matches(card));
		expect(await render(remainingCards, matches, 0)).toEqual({
			total: 1,
			completed: 1,
		});
		expect(await render(remainingCards, matches, 0)).toEqual({
			total: 1,
			completed: 1,
		});
		expect(await render([], matches, 0)).toEqual({ total: 1, completed: 1 });
		expect(await render(cards, matches, 1)).toEqual({ total: 1, completed: 0 });
	},
);

it.each(filters)(
	"retains same-id updates to $name metadata",
	async ({ matches }) => {
		const initial = { ...answer, askKind: "decide", draftedNotSent: false };
		expect(await render([initial], matches, 0)).toEqual({
			total: 0,
			completed: 0,
		});
		const updated = { ...initial, askKind: "answer", draftedNotSent: true };
		expect(await render([updated], matches, 1)).toEqual({
			total: 1,
			completed: 0,
		});
		expect(await render([], matches, 0)).toEqual({ total: 1, completed: 1 });
		expect(await render([initial], matches, 0)).toEqual({
			total: 0,
			completed: 0,
		});
		expect(await render([], matches, 0)).toEqual({ total: 0, completed: 0 });
	},
);

it("retains the other filter fields from the latest card metadata", async () => {
	const updated = {
		...answer,
		project: "grove",
		urgency: "urgent",
		label: "Updated proposal",
	};
	const matches = (card: ProgressCard) =>
		card.kind === "question" &&
		card.project === "grove" &&
		card.urgency === "urgent" &&
		card.label.toLowerCase().includes("updated");
	expect(await render([answer], matches, 0)).toEqual({
		total: 0,
		completed: 0,
	});
	expect(await render([updated], matches, 1)).toEqual({
		total: 1,
		completed: 0,
	});
	expect(await render([], matches, 0)).toEqual({ total: 1, completed: 1 });
});

it.each(filters)(
	"resets retained $name cards when the deck identity changes",
	async ({ matches }) => {
		expect(await render([answer, outbound], matches, 1)).toEqual({
			total: 1,
			completed: 0,
		});
		expect(
			await render([], matches, 0, "other-workspace:person:decide"),
		).toEqual({ total: 0, completed: 0 });
		expect(
			await render(
				[answer, outbound],
				matches,
				1,
				"other-workspace:person:decide",
			),
		).toEqual({ total: 1, completed: 0 });
		expect(
			await render([], matches, 0, "other-workspace:other-person:practice"),
		).toEqual({ total: 0, completed: 0 });
		expect(await render([], matches, 0)).toEqual({ total: 0, completed: 0 });
	},
);
