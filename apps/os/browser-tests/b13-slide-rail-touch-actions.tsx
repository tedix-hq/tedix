import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { SlideList } from "../src/components/output-editor-slide-list";
import "../src/styles.css";

const mode =
	new URLSearchParams(location.search).get("theme") === "dark"
		? "dark"
		: "light";
document.documentElement.classList.toggle("dark", mode === "dark");
document.documentElement.dataset.mode = mode;
document.documentElement.dataset.theme = "tedix";

function mkSlide(
	id: string,
	name: string,
	label: string,
): OsPresentationCanvasSlide {
	return {
		id,
		name,
		layout: "title-content",
		background: "#ffffff",
		elements: [
			{
				id: `${id}-title`,
				type: "title",
				x: 70,
				y: 84,
				width: 1060,
				height: 90,
				text: label,
				style: { fontSize: 36, fontWeight: "semibold", color: "#171717" },
			},
			{
				id: `${id}-body`,
				type: "text",
				x: 70,
				y: 210,
				width: 760,
				height: 300,
				text: `${label} — supporting copy.`,
				style: { fontSize: 22, color: "#242424" },
			},
		],
	};
}

function deckOf(slides: OsPresentationCanvasSlide[]): OsPresentationDeck {
	return {
		width: 1200,
		height: 675,
		activeSlideId: slides[0]!.id,
		slides,
	};
}

const editableInitial = deckOf([
	mkSlide("e1", "Slide 1", "Alpha revenue summary"),
	mkSlide("e2", "Slide 2", "Beta hiring plan"),
	mkSlide("e3", "Slide 3", "Gamma rollout dates"),
	mkSlide("e4", "Slide 4", "Delta next steps"),
]);
const readonlyInitial = deckOf([
	mkSlide("r1", "Slide 1", "Read only alpha"),
	mkSlide("r2", "Slide 2", "Read only beta"),
	mkSlide("r3", "Slide 3", "Read only gamma"),
]);
const cappedInitial = deckOf([
	mkSlide("c1", "Slide 1", "Capped alpha"),
	mkSlide("c2", "Slide 2", "Capped beta"),
	mkSlide("c3", "Slide 3", "Capped gamma"),
]);

function Harness({
	initial,
	disabled,
	maxSlides,
}: {
	initial: OsPresentationDeck;
	disabled: boolean;
	maxSlides: number;
}) {
	const [deck, setDeck] = useState(initial);
	const [viewed, setViewed] = useState(initial.activeSlideId);
	const [history, setHistory] = useState<OsPresentationDeck[]>([]);
	return (
		<>
			<SlideList
				deck={deck}
				activeSlideId={viewed}
				disabled={disabled}
				maxSlides={maxSlides}
				onView={setViewed}
				onCommit={(next) => {
					setHistory((past) => [...past, deck]);
					setDeck(next);
				}}
			/>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={history.length === 0}
				onClick={() => {
					const past = history.at(-1);
					if (!past) return;
					setHistory(history.slice(0, -1));
					setDeck(past);
				}}
			>
				Undo
			</Button>
			<pre data-deck-state className="sr-only">
				{JSON.stringify({
					names: deck.slides.map((slide) => slide.name),
					viewed,
					deckActive: deck.activeSlideId,
				})}
			</pre>
		</>
	);
}

createRoot(document.getElementById("root")!).render(
	<main className="mx-auto grid max-w-sm gap-6 p-4 text-kumo-default">
		<h1 className="text-lg font-medium">Slide rail</h1>
		<section data-variant="editable" className="min-w-0">
			<h2 className="mb-2 text-sm font-medium">Editable</h2>
			<Harness initial={editableInitial} disabled={false} maxSlides={6} />
		</section>
		<section data-variant="readonly" className="min-w-0">
			<h2 className="mb-2 text-sm font-medium">Read only</h2>
			<Harness initial={readonlyInitial} disabled maxSlides={3} />
		</section>
		<section data-variant="capped" className="min-w-0">
			<h2 className="mb-2 text-sm font-medium">At slide cap</h2>
			<Harness initial={cappedInitial} disabled={false} maxSlides={3} />
		</section>
	</main>,
);
