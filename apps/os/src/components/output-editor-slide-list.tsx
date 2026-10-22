import { Copy, Trash } from "@phosphor-icons/react";
import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { SearchInput } from "@/components/kumo/search-input";
import { Text } from "@/components/kumo/text";
import { ReadOnlySlide } from "@/components/output-slide-element";
import { createOutputNodeId } from "@/lib/output-models";

type SlideLayout = OsPresentationCanvasSlide["layout"];

const INK = "#171717";
const BODY = "#242424";
const MUTED = "#555555";

/** A text element of a slide template, with neutral type and no branding. */
function templateText(
	id: string,
	type: OsPresentationElement["type"],
	geometry: Pick<OsPresentationElement, "x" | "y" | "width" | "height">,
	text: string,
	style: OsPresentationElement["style"],
): OsPresentationElement {
	return { id, type, ...geometry, text, style };
}

function contentShell(id: string): OsPresentationElement[] {
	return [
		templateText(
			`${id}-section`,
			"label",
			{ x: 70, y: 40, width: 260, height: 36 },
			"SECTION",
			{ fontSize: 14, fontWeight: "semibold", color: MUTED },
		),
		templateText(
			`${id}-title`,
			"title",
			{ x: 70, y: 84, width: 1060, height: 90 },
			"Write the headline as a specific assertion",
			{ fontSize: 36, fontWeight: "semibold", color: INK },
		),
	];
}

function footerBar(id: string): OsPresentationElement {
	return {
		id: `${id}-bar`,
		type: "divider",
		x: 0,
		y: 663,
		width: 1200,
		height: 12,
		style: { background: INK },
	};
}

/**
 * A new slide in one of the schema's layouts, built from ordinary editable
 * elements: a cover (title + subtitle) or a content slide (section label,
 * headline, body in one, two or four columns, and a footer bar).
 */
export function templateSlide(
	layout: SlideLayout,
	index: number,
): OsPresentationCanvasSlide {
	const id = createOutputNodeId("slide");
	const elements: OsPresentationElement[] = [];
	if (layout === "title") {
		elements.push(
			{
				id: `${id}-rule`,
				type: "divider",
				x: 80,
				y: 210,
				width: 120,
				height: 8,
				style: { background: INK },
			},
			templateText(
				`${id}-title`,
				"title",
				{ x: 80, y: 240, width: 1040, height: 150 },
				"Presentation title",
				{ fontSize: 60, fontWeight: "bold", color: INK },
			),
			templateText(
				`${id}-subtitle`,
				"subtitle",
				{ x: 80, y: 520, width: 900, height: 60 },
				"Subtitle",
				{ fontSize: 24, fontWeight: "medium", color: MUTED },
			),
		);
	}
	if (layout === "title-content") {
		elements.push(
			...contentShell(id),
			templateText(
				`${id}-body`,
				"text",
				{ x: 70, y: 210, width: 760, height: 300 },
				"Replace this with one or two short paragraphs of supporting evidence. Keep body copy to roughly 40 to 60 words.",
				{ fontSize: 22, color: BODY },
			),
			footerBar(id),
		);
	}
	if (layout === "two-column") {
		elements.push(...contentShell(id));
		[70, 625].forEach((x, column) => {
			elements.push(
				templateText(
					`${id}-heading-${column + 1}`,
					"text",
					{ x, y: 210, width: 505, height: 44 },
					"Column heading",
					{ fontSize: 22, fontWeight: "semibold", color: INK },
				),
				templateText(
					`${id}-column-${column + 1}`,
					"text",
					{ x, y: 262, width: 505, height: 260 },
					"Add concise supporting copy. Keep both columns parallel in structure and similar in length.",
					{ fontSize: 20, color: BODY },
				),
			);
		});
		elements.push(footerBar(id));
	}
	if (layout === "four-card") {
		elements.push(...contentShell(id));
		for (let card = 0; card < 4; card += 1)
			elements.push({
				id: `${id}-card-${card + 1}`,
				type: "card",
				x: 70 + card * 270,
				y: 210,
				width: 250,
				height: 340,
				props: {
					eyebrow: `0${card + 1}`,
					title: "Card heading",
					body: "One clear idea per card.",
					tone: "neutral",
				},
				style: {},
			});
		elements.push(footerBar(id));
	}
	return {
		id,
		name: `Slide ${index + 1}`,
		layout,
		background: "#ffffff",
		elements,
	};
}

const LABEL_TYPES = ["title", "subtitle", "text"] as const;

/** One line for a slide row: its first title, else subtitle, else text. */
export function slideLabel(slide: OsPresentationCanvasSlide): string {
	for (const type of LABEL_TYPES)
		for (const element of slide.elements) {
			const text = element.type === type ? element.text?.trim() : undefined;
			if (text) return text.replace(/\s+/g, " ");
		}
	return slide.name;
}

/** Whether the slide's name or any of its elements' text contains the query. */
export function slideMatches(
	slide: OsPresentationCanvasSlide,
	query: string,
): boolean {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return true;
	return [
		slide.name,
		...slide.elements.flatMap((element) => [
			element.text,
			element.props?.eyebrow,
			element.props?.title,
			element.props?.body,
			element.props?.label,
		]),
	]
		.join("\n")
		.toLocaleLowerCase()
		.includes(needle);
}

export function insertSlideAfter(
	deck: OsPresentationDeck,
	slide: OsPresentationCanvasSlide,
	afterId: string | undefined,
): OsPresentationDeck {
	const at = deck.slides.findIndex((candidate) => candidate.id === afterId);
	const slides = [...deck.slides];
	slides.splice(at === -1 ? slides.length : at + 1, 0, slide);
	return { ...deck, activeSlideId: slide.id, slides };
}

export function moveSlide(
	deck: OsPresentationDeck,
	from: number,
	to: number,
): OsPresentationDeck {
	if (from === to || !deck.slides[from] || to < 0 || to >= deck.slides.length)
		return deck;
	const slides = [...deck.slides];
	const [moved] = slides.splice(from, 1);
	slides.splice(to, 0, moved!);
	return { ...deck, slides };
}

export function duplicateSlide(
	deck: OsPresentationDeck,
	slideId: string,
): OsPresentationDeck {
	const source = deck.slides.find((slide) => slide.id === slideId);
	if (!source) return deck;
	return insertSlideAfter(
		deck,
		{
			...source,
			id: createOutputNodeId("slide"),
			name: `${source.name} copy`.slice(0, 200),
			elements: source.elements.map((element) => ({
				...element,
				id: createOutputNodeId(element.type),
			})),
		},
		source.id,
	);
}

/** Removes a slide; the viewed slide stays active unless it was the one removed. */
export function deleteSlide(
	deck: OsPresentationDeck,
	slideId: string,
	viewedId: string,
): OsPresentationDeck {
	const index = deck.slides.findIndex((slide) => slide.id === slideId);
	if (index === -1) return deck;
	const slides = deck.slides.filter((slide) => slide.id !== slideId);
	const activeSlideId =
		slideId === viewedId
			? (slides[Math.min(index, slides.length - 1)]?.id ?? "slide-1")
			: viewedId;
	return { ...deck, slides, activeSlideId };
}

interface SlideListProps {
	deck: OsPresentationDeck;
	activeSlideId: string;
	disabled: boolean;
	maxSlides: number;
	onView: (slideId: string) => void;
	onCommit: (next: OsPresentationDeck) => void;
}

/**
 * The editor's slide rail: search, numbered thumbnails with a one-line label,
 * hover/focus duplicate and delete, and reordering by drag or Alt+Arrow.
 * Every change goes through `onCommit`, the editor's undo history.
 */
export function SlideList({
	deck,
	activeSlideId,
	disabled,
	maxSlides,
	onView,
	onCommit,
}: SlideListProps) {
	const [search, setSearch] = useState("");
	const [dragId, setDragId] = useState<string | null>(null);
	const [drop, setDrop] = useState<{ index: number; before: boolean } | null>(
		null,
	);
	const [announcement, setAnnouncement] = useState("");
	const focusAfterMove = useRef<string | null>(null);
	const listRef = useRef<HTMLOListElement>(null);
	const filtering = search.trim().length > 0;
	const canReorder = !disabled && !filtering;
	const visible = deck.slides
		.map((slide, index) => ({ slide, index }))
		.filter(({ slide }) => slideMatches(slide, search));

	useEffect(() => {
		const id = focusAfterMove.current;
		if (!id) return;
		focusAfterMove.current = null;
		listRef.current
			?.querySelector<HTMLElement>(`[data-slide-row="${id}"] [data-slide-open]`)
			?.focus();
	});

	const move = (from: number, to: number) => {
		const slide = deck.slides[from];
		const next = moveSlide(deck, from, to);
		if (!slide || next === deck) return;
		focusAfterMove.current = slide.id;
		onCommit(next);
		setAnnouncement(
			`Moved ${slideLabel(slide)} to position ${to + 1} of ${deck.slides.length}`,
		);
	};

	const endDrag = () => {
		setDragId(null);
		setDrop(null);
	};

	return (
		<>
			<SearchInput
				aria-label="Search slides"
				placeholder="Search slides"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						const first = visible[0];
						if (filtering && first) onView(first.slide.id);
					} else if (event.key === "Escape" && search) {
						event.preventDefault();
						event.stopPropagation();
						setSearch("");
					}
				}}
			/>
			<ol
				ref={listRef}
				className="m-0 grid list-none grid-cols-1 content-start gap-1.5 overflow-y-auto p-0 max-sm:grid-cols-2"
			>
				{visible.length === 0 && (
					<li>
						<Text role="label" tone="secondary" className="m-0 p-3 text-center">
							No slides match
						</Text>
					</li>
				)}
				{visible.map(({ slide, index }) => {
					const label = slideLabel(slide);
					const active = slide.id === activeSlideId;
					const dropAt =
						drop?.index === index ? (drop.before ? "before" : "after") : null;
					return (
						<li
							key={slide.id}
							className="slide-list-row group relative coarse:flex coarse:items-center"
							data-slide-row={slide.id}
							data-drop={dropAt ?? undefined}
							data-dragging={dragId === slide.id || undefined}
							draggable={canReorder}
							onDragStart={(event) => {
								if (!canReorder) return;
								setDragId(slide.id);
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData("text/plain", slide.id);
							}}
							onDragEnd={endDrag}
							onDragOver={(event) => {
								if (!dragId) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								const from = deck.slides.findIndex((s) => s.id === dragId);
								const rect = event.currentTarget.getBoundingClientRect();
								const before = event.clientY - rect.top < rect.height / 2;
								const noop =
									from === index ||
									(before ? from === index - 1 : from === index + 1);
								setDrop(noop ? null : { index, before });
							}}
							onDragLeave={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget as Node))
									setDrop((current) =>
										current?.index === index ? null : current,
									);
							}}
							onDrop={(event) => {
								event.preventDefault();
								const from = deck.slides.findIndex((s) => s.id === dragId);
								endDrag();
								if (from === -1 || !drop || drop.index !== index) return;
								let to = drop.before ? index : index + 1;
								if (from < to) to -= 1;
								move(from, to);
							}}
						>
							<Button
								data-slide-open=""
								aria-current={active || undefined}
								aria-keyshortcuts={
									canReorder ? "Alt+ArrowUp Alt+ArrowDown" : undefined
								}
								/*
								 * Names the row explicitly. Without it the accessible name is
								 * the button's whole text content, which includes the
								 * thumbnail's copy, so every slide was read out twice.
								 */
								aria-label={`Slide ${index + 1}: ${label}`}
								className="deck-read-thumb w-full flex-col items-stretch gap-1 p-1 text-left coarse:min-w-0"
								multiline
								size="sm"
								variant={active ? "secondary" : "outline"}
								onClick={() => onView(slide.id)}
								onKeyDown={(event) => {
									if (
										!canReorder ||
										!event.altKey ||
										(event.key !== "ArrowUp" && event.key !== "ArrowDown")
									)
										return;
									event.preventDefault();
									move(index, index + (event.key === "ArrowUp" ? -1 : 1));
								}}
							>
								<Text
									as="span"
									className="block text-kumo-subtle tabular-nums"
									role="caption"
								>
									{index + 1}
								</Text>
								<ReadOnlySlide slide={slide} className="slide-thumb-canvas" />
								<Text as="span" className="block wrap-anywhere" role="caption">
									{label}
								</Text>
							</Button>
							<div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 coarse:static coarse:ml-1 coarse:shrink-0 coarse:flex-col coarse:gap-1.5 coarse:opacity-100">
								<Button
									type="button"
									size="icon-xs"
									variant="secondary"
									aria-label="Duplicate slide"
									className="coarse:size-11"
									disabled={disabled || deck.slides.length >= maxSlides}
									onClick={() => onCommit(duplicateSlide(deck, slide.id))}
								>
									<Copy size={13} />
								</Button>
								<Button
									type="button"
									size="icon-xs"
									variant="secondary"
									aria-label="Delete slide"
									className="coarse:size-11"
									disabled={disabled}
									onClick={() =>
										onCommit(deleteSlide(deck, slide.id, activeSlideId))
									}
								>
									<Trash size={13} />
								</Button>
							</div>
						</li>
					);
				})}
			</ol>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</>
	);
}
