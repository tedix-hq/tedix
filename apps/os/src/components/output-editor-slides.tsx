import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUDownLeft,
	ArrowUDownRight,
	ArrowUp,
	ArrowsOut,
	Copy,
	MagnifyingGlass,
	Play,
	Plus,
	SidebarSimple,
	SlidersHorizontal,
	Trash,
} from "@phosphor-icons/react";
import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMemo, useState } from "react";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import { Toolbar } from "@/components/kumo/toolbar";
import { ReadOnlyElement } from "@/components/output-slide-element";
import {
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import {
	createOutputNodeId,
	normalizePresentationContent,
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
	presentationCanvasLength,
	projectDeck,
	type PresentationContent,
} from "@/lib/output-models";
import { useEditorHistory } from "@/lib/use-editor-history";

const MAX_SLIDES = 200;
const MAX_NOTES_LENGTH = 10_000;
export const PRESENTATION_ELEMENT_TYPES = [
	"title",
	"subtitle",
	"text",
	"bullet",
	"label",
	"card",
	"box",
	"image",
	"svg",
	"divider",
	"shape",
	"arrow",
] as const satisfies readonly OsPresentationElementType[];

const ELEMENT_DEFAULTS: Record<
	OsPresentationElementType,
	Pick<OsPresentationElement, "width" | "height" | "text" | "style">
> = {
	title: {
		width: 900,
		height: 90,
		text: "Title",
		style: { fontSize: 48, fontWeight: "bold", color: "#171717" },
	},
	subtitle: {
		width: 800,
		height: 65,
		text: "Subtitle",
		style: { fontSize: 28, color: "#555555" },
	},
	text: {
		width: 540,
		height: 140,
		text: "Text",
		style: { fontSize: 24, color: "#242424" },
	},
	bullet: {
		width: 650,
		height: 250,
		text: "First point\nSecond point",
		style: { fontSize: 26, color: "#242424" },
	},
	label: {
		width: 220,
		height: 48,
		text: "LABEL",
		style: {
			fontSize: 18,
			fontWeight: "semibold",
			color: "#333333",
			background: "#f1f1f1",
			borderRadius: 12,
		},
	},
	card: {
		width: 360,
		height: 220,
		text: "Card",
		style: {
			fontSize: 24,
			color: "#242424",
			background: "#ffffff",
			borderColor: "#d1d1d1",
			borderWidth: 2,
			borderRadius: 18,
		},
	},
	box: {
		width: 300,
		height: 180,
		text: "Box",
		style: {
			fontSize: 22,
			color: "#242424",
			background: "#f3f5ff",
			borderRadius: 12,
		},
	},
	image: {
		width: 420,
		height: 260,
		text: "Image",
		style: { background: "#eeeeee", borderRadius: 12 },
	},
	svg: {
		width: 280,
		height: 200,
		text: "SVG",
		style: { background: "#eeeeee" },
	},
	divider: { width: 700, height: 8, style: { background: "#222222" } },
	shape: {
		width: 180,
		height: 180,
		style: { background: "#ff6b35", borderRadius: 90 },
	},
	arrow: {
		width: 300,
		height: 40,
		text: "→",
		style: { fontSize: 56, color: "#222222", textAlign: "center" },
	},
};

function createElement(
	type: OsPresentationElementType,
	index: number,
): OsPresentationElement {
	return {
		id: createOutputNodeId(type),
		type,
		x: 80 + (index % 5) * 24,
		y: 80 + (index % 5) * 24,
		...ELEMENT_DEFAULTS[type],
	};
}

function templateSlide(
	layout: OsPresentationCanvasSlide["layout"],
	index: number,
): OsPresentationCanvasSlide {
	const id = createOutputNodeId("slide");
	const elements: OsPresentationElement[] = [];
	if (layout !== "blank")
		elements.push({
			...createElement("title", 0),
			id: `${id}-title`,
			x: 70,
			y: 55,
			width: 1060,
			text: "Presentation title",
		});
	if (layout === "title-content")
		elements.push({
			...createElement("bullet", 1),
			id: `${id}-content`,
			x: 95,
			y: 185,
			width: 1010,
			height: 360,
		});
	if (layout === "two-column") {
		elements.push({
			...createElement("text", 1),
			id: `${id}-left`,
			x: 75,
			y: 190,
			width: 500,
			height: 360,
			text: "Left column",
		});
		elements.push({
			...createElement("text", 2),
			id: `${id}-right`,
			x: 625,
			y: 190,
			width: 500,
			height: 360,
			text: "Right column",
		});
	}
	if (layout === "four-card") {
		for (let card = 0; card < 4; card += 1)
			elements.push({
				...createElement("card", card),
				id: `${id}-card-${card + 1}`,
				x: 70 + (card % 2) * 555,
				y: 180 + Math.floor(card / 2) * 215,
				width: 505,
				height: 180,
				text: `Card ${card + 1}`,
			});
	}
	return {
		id,
		name: `Slide ${index + 1}`,
		layout,
		background: "#ffffff",
		elements,
	};
}

function replaceActiveSlide(
	deck: OsPresentationDeck,
	next: OsPresentationCanvasSlide,
): OsPresentationDeck {
	return {
		...deck,
		slides: deck.slides.map((slide) => (slide.id === next.id ? next : slide)),
	};
}

function SlideElementView({
	element,
	selected,
	disabled,
	onSelect,
	onChange,
	onGeometryCommit,
}: {
	element: OsPresentationElement;
	selected: boolean;
	disabled?: boolean;
	onSelect: () => void;
	onChange: (next: OsPresentationElement) => void;
	onGeometryCommit: (next: OsPresentationElement) => void;
}) {
	const [gesture, setGesture] = useState<null | {
		mode: "move" | "resize";
		startX: number;
		startY: number;
		origin: OsPresentationElement;
		dx: number;
		dy: number;
		scale: number;
	}>(null);
	const current = gesture
		? {
				...element,
				x:
					gesture.mode === "move"
						? Math.max(
								0,
								Math.min(
									PRESENTATION_WIDTH - element.width,
									gesture.origin.x + gesture.dx / gesture.scale,
								),
							)
						: element.x,
				y:
					gesture.mode === "move"
						? Math.max(
								0,
								Math.min(
									PRESENTATION_HEIGHT - element.height,
									gesture.origin.y + gesture.dy / gesture.scale,
								),
							)
						: element.y,
				width:
					gesture.mode === "resize"
						? Math.max(
								24,
								Math.min(
									PRESENTATION_WIDTH - element.x,
									gesture.origin.width + gesture.dx / gesture.scale,
								),
							)
						: element.width,
				height:
					gesture.mode === "resize"
						? Math.max(
								24,
								Math.min(
									PRESENTATION_HEIGHT - element.y,
									gesture.origin.height + gesture.dy / gesture.scale,
								),
							)
						: element.height,
			}
		: element;
	const textStyle = {
		fontFamily: current.style.fontFamily,
		fontSize: presentationCanvasLength(current.style.fontSize ?? 24),
		fontWeight:
			current.style.fontWeight === "semibold"
				? 600
				: current.style.fontWeight === "medium"
					? 500
					: current.style.fontWeight,
		color: current.style.color,
		textAlign: current.style.textAlign,
		opacity: current.style.opacity,
		transform: current.style.rotation
			? `rotate(${current.style.rotation}deg)`
			: undefined,
	} as const;
	const startGesture = (mode: "move" | "resize", event: React.PointerEvent) => {
		if (disabled) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		onSelect();
		const elementNode = (event.currentTarget as HTMLElement).closest(
			"[data-element]",
		) as HTMLElement | null;
		const canvasWidth =
			elementNode?.parentElement?.getBoundingClientRect().width;
		setGesture({
			mode,
			startX: event.clientX,
			startY: event.clientY,
			origin: element,
			dx: 0,
			dy: 0,
			scale:
				canvasWidth && canvasWidth > 0 ? canvasWidth / PRESENTATION_WIDTH : 1,
		});
	};
	const moveGesture = (event: React.PointerEvent) =>
		setGesture((active) =>
			active
				? {
						...active,
						dx: event.clientX - active.startX,
						dy: event.clientY - active.startY,
					}
				: active,
		);
	const endGesture = () => {
		if (gesture) onGeometryCommit(current);
		setGesture(null);
	};
	return (
		<div
			data-element={element.type}
			aria-label={`${element.type} element`}
			role="group"
			tabIndex={disabled ? -1 : 0}
			className={`absolute overflow-hidden outline-none ${selected ? "ring-2 ring-kumo-focus ring-offset-2" : "focus-visible:ring-2 focus-visible:ring-kumo-focus"}`}
			style={{
				left: `${(current.x / PRESENTATION_WIDTH) * 100}%`,
				top: `${(current.y / PRESENTATION_HEIGHT) * 100}%`,
				width: `${(current.width / PRESENTATION_WIDTH) * 100}%`,
				height: `${(current.height / PRESENTATION_HEIGHT) * 100}%`,
				background: current.style.background,
				borderColor: current.style.borderColor,
				borderWidth: current.style.borderWidth,
				borderRadius: current.style.borderRadius,
				...textStyle,
			}}
			onClick={(event) => {
				event.stopPropagation();
				onSelect();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect();
				}
			}}
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) startGesture("move", event);
			}}
			onPointerMove={moveGesture}
			onPointerUp={endGesture}
		>
			{(current.type === "image" || current.type === "svg") && current.src ? (
				<img
					src={current.src}
					alt={current.text ?? "Slide visual"}
					className="h-full w-full object-contain"
				/>
			) : current.type === "divider" || current.type === "shape" ? null : (
				<Textarea
					aria-label={`${current.type} text`}
					className={`h-full min-h-0 w-full resize-none rounded-none border-0 bg-transparent p-0 shadow-none ring-0 outline-none ${current.type === "bullet" ? "whitespace-pre-line" : ""}`}
					style={textStyle}
					disabled={disabled}
					value={current.text ?? ""}
					onPointerDown={(event) => event.stopPropagation()}
					onChange={(event) =>
						onChange({ ...element, text: event.target.value })
					}
				/>
			)}
			{selected && !disabled && (
				<Button
					aria-label="Resize selected element"
					className="absolute right-0 bottom-0 size-5 min-h-5 min-w-5 cursor-se-resize rounded-sm bg-kumo-focus p-0 sm:size-5"
					size="icon-xs"
					variant="ghost"
					onPointerDown={(event) => startGesture("resize", event)}
					onPointerMove={moveGesture}
					onPointerUp={endGesture}
				/>
			)}
		</div>
	);
}

function SlideCanvas({
	slide,
	selectedElementId,
	disabled,
	onSelect,
	onChangeElement,
	onGeometryCommit,
}: {
	slide: OsPresentationCanvasSlide;
	selectedElementId: string | null;
	disabled?: boolean;
	onSelect: (id: string | null) => void;
	onChangeElement: (next: OsPresentationElement) => void;
	onGeometryCommit: (next: OsPresentationElement) => void;
}) {
	return (
		<div
			className="slides-editor-canvas relative overflow-hidden"
			style={{
				background: slide.background,
				containerType: "inline-size",
			}}
			onClick={() => onSelect(null)}
		>
			{slide.elements.map((element) => (
				<SlideElementView
					key={element.id}
					element={element}
					selected={element.id === selectedElementId}
					disabled={disabled}
					onSelect={() => onSelect(element.id)}
					onChange={onChangeElement}
					onGeometryCommit={onGeometryCommit}
				/>
			))}
		</div>
	);
}

interface SlidesEditorProps {
	value: PresentationContent;
	onChange: (next: PresentationContent) => void;
	disabled?: boolean;
}

export function SlidesEditor({
	value,
	onChange,
	disabled = false,
}: SlidesEditorProps) {
	const normalized = normalizePresentationContent(value);
	const deck = normalized.deck!;
	const activeSlide =
		deck.slides.find((slide) => slide.id === deck.activeSlideId) ??
		deck.slides[0] ??
		null;
	const [selectedElementId, setSelectedElementId] = useState<string | null>(
		null,
	);
	const [search, setSearch] = useState("");
	const [presenting, setPresenting] = useState(false);
	const [showThumbnails, setShowThumbnails] = useState(true);
	const [showInspector, setShowInspector] = useState(false);
	const [assetElementType, setAssetElementType] = useState<
		"image" | "svg" | null
	>(null);
	const history = useEditorHistory(normalized, onChange);
	const selectedElement =
		activeSlide?.elements.find((element) => element.id === selectedElementId) ??
		null;
	const filteredSlides = useMemo(
		() =>
			deck.slides.filter((slide) =>
				slide.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
			),
		[deck.slides, search],
	);
	const commitDeck = (next: OsPresentationDeck) =>
		history.commit(projectDeck(next));
	const updateElement = (next: OsPresentationElement, record = true) => {
		if (!activeSlide) return;
		const nextDeck = replaceActiveSlide(deck, {
			...activeSlide,
			elements: activeSlide.elements.map((element) =>
				element.id === next.id ? next : element,
			),
		});
		if (record) commitDeck(nextDeck);
		else onChange(projectDeck(nextDeck));
	};
	const addTemplate = (layout: OsPresentationCanvasSlide["layout"]) => {
		if (deck.slides.length >= MAX_SLIDES) return;
		const slide = templateSlide(layout, deck.slides.length);
		commitDeck({
			...deck,
			activeSlideId: slide.id,
			slides: [...deck.slides, slide],
		});
		setSelectedElementId(slide.elements[0]?.id ?? null);
	};
	const insertElement = (type: OsPresentationElementType, src?: string) => {
		if (!activeSlide) return;
		const element = createElement(type, activeSlide.elements.length);
		if (src) element.src = src;
		commitDeck(
			replaceActiveSlide(deck, {
				...activeSlide,
				elements: [...activeSlide.elements, element],
			}),
		);
		setSelectedElementId(element.id);
		setShowInspector(true);
		setShowThumbnails(false);
	};
	const addElement = (type: OsPresentationElementType) => {
		if (type === "image" || type === "svg") {
			setAssetElementType(type);
			return;
		}
		insertElement(type);
	};

	if (!activeSlide) {
		return (
			<Surface
				tier="panel"
				className="grid justify-items-start gap-3 border-dashed p-8"
			>
				<p className="m-0 text-kumo-subtle">
					This presentation has no slides yet.
				</p>
				<Button
					size="sm"
					disabled={disabled}
					onClick={() => addTemplate("title-content")}
				>
					<Plus size={14} /> Add slide
				</Button>
			</Surface>
		);
	}

	return (
		<div
			className="slides-editor grid min-w-0 gap-0"
			data-editor="presentation-canvas"
			style={{ containerType: "inline-size" }}
			onKeyDown={(event) => {
				if (
					!selectedElement ||
					disabled ||
					["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)
				)
					return;
				if (event.key === "Delete" || event.key === "Backspace") {
					event.preventDefault();
					commitDeck(
						replaceActiveSlide(deck, {
							...activeSlide,
							elements: activeSlide.elements.filter(
								(element) => element.id !== selectedElement.id,
							),
						}),
					);
					setSelectedElementId(null);
					return;
				}
				const movement: Record<string, [number, number]> = {
					ArrowLeft: [-1, 0],
					ArrowRight: [1, 0],
					ArrowUp: [0, -1],
					ArrowDown: [0, 1],
				};
				const delta = movement[event.key];
				if (delta) {
					event.preventDefault();
					const amount = event.shiftKey ? 10 : 1;
					updateElement({
						...selectedElement,
						x: Math.max(
							0,
							Math.min(
								PRESENTATION_WIDTH - selectedElement.width,
								selectedElement.x + delta[0] * amount,
							),
						),
						y: Math.max(
							0,
							Math.min(
								PRESENTATION_HEIGHT - selectedElement.height,
								selectedElement.y + delta[1] * amount,
							),
						),
					});
				}
			}}
		>
			<EditorToolbar>
				<EditorToolbarButton
					label="Undo"
					disabled={disabled || !history.canUndo}
					onClick={history.undo}
				>
					<ArrowUDownLeft size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Redo"
					disabled={disabled || !history.canRedo}
					onClick={history.redo}
				>
					<ArrowUDownRight size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				<Select
					disabled={disabled}
					value=""
					onValueChange={(value) => {
						if (value)
							addTemplate(value as OsPresentationCanvasSlide["layout"]);
					}}
				>
					<SelectTrigger
						aria-label="New slide template"
						className="w-32"
						size="sm"
					>
						<SelectValue>{() => "Add slide…"}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="blank">Blank</SelectItem>
						<SelectItem value="title">Title</SelectItem>
						<SelectItem value="title-content">Title + content</SelectItem>
						<SelectItem value="two-column">Two column</SelectItem>
						<SelectItem value="four-card">Four card</SelectItem>
					</SelectContent>
				</Select>
				<Select
					disabled={disabled}
					value=""
					onValueChange={(value) => {
						if (value) addElement(value as OsPresentationElementType);
					}}
				>
					<SelectTrigger
						aria-label="Insert slide element"
						className="w-28"
						size="sm"
					>
						<SelectValue>{() => "Insert…"}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{PRESENTATION_ELEMENT_TYPES.map((type) => (
							<SelectItem className="capitalize" key={type} value={type}>
								{type}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<EditorToolbarDivider />
				{/*
				 * Pane toggles are icon targets like every other square control
				 * in the row. They previously rendered as text buttons at three
				 * different widths, which is what made this toolbar read as a
				 * different product from Document and Sheet. The accessible name
				 * and the pressed state carry the meaning the label used to.
				 */}
				<EditorToolbarButton
					label="Slide rail"
					active={showThumbnails}
					onClick={() => {
						setShowThumbnails((visible) => !visible);
						if (!showThumbnails) setShowInspector(false);
					}}
				>
					<SidebarSimple size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Inspector"
					active={showInspector}
					onClick={() => {
						setShowInspector((visible) => !visible);
						if (!showInspector) setShowThumbnails(false);
					}}
				>
					<SlidersHorizontal size={15} />
				</EditorToolbarButton>
				<Toolbar.Button
					type="button"
					className="ml-auto"
					disabled={disabled}
					onClick={() => setPresenting(true)}
				>
					<Play size={14} /> Present
				</Toolbar.Button>
			</EditorToolbar>
			<div
				className="slides-editor-layout grid min-h-[68vh] gap-2"
				data-show-inspector={showInspector || undefined}
				data-show-thumbnails={showThumbnails || undefined}
			>
				<aside
					className="slides-editor-chrome slides-editor-thumbnails grid min-w-0 content-start gap-2 p-2"
					hidden={!showThumbnails}
				>
					<div className="relative">
						<MagnifyingGlass
							size={14}
							className="absolute top-2.5 left-2 text-kumo-subtle"
						/>
						<Input
							aria-label="Search slides"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							className="pl-7"
						/>
					</div>
					<ol className="m-0 grid list-none content-start gap-2 overflow-auto p-0">
						{filteredSlides.map((slide, index) => (
							<li key={slide.id}>
								<Button
									aria-current={slide.id === activeSlide.id || undefined}
									/*
									 * Names the thumbnail explicitly, the same way the read
									 * view rail does. Without it the accessible name is the
									 * button's whole text content — which includes the
									 * scale-model canvas below, so every slide's body copy
									 * was read out twice and the title was duplicated
									 * ("1. Tedix OS parityTedix OS parityCloudflare-native…").
									 */
									aria-label={`Slide ${index + 1}: ${slide.name}`}
									className="deck-read-thumb w-full flex-col items-stretch gap-1 p-1 text-left"
									multiline
									size="sm"
									variant={
										slide.id === activeSlide.id ? "secondary" : "outline"
									}
									onClick={() => {
										commitDeck({ ...deck, activeSlideId: slide.id });
										setSelectedElementId(null);
									}}
								>
									<Text
										as="span"
										className="mb-1 block text-kumo-subtle"
										role="caption"
									>
										{index + 1}. {slide.name}
									</Text>
									{/*
									 * The shared renderer, the same one the read view rail
									 * and the committed canvas use. This used to be an
									 * inline `text-[4px]` span carrying only background and
									 * colour: it ignored weight, alignment, opacity,
									 * rotation and borders, and dropped images entirely.
									 */}
									<div
										className="slide-thumb-canvas"
										style={{ background: slide.background }}
									>
										{slide.elements.map((element) => (
											<ReadOnlyElement element={element} key={element.id} />
										))}
									</div>
								</Button>
							</li>
						))}
					</ol>
					<div className="flex gap-1">
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label="Move slide up"
							disabled={disabled || deck.slides.indexOf(activeSlide) === 0}
							onClick={() => {
								const index = deck.slides.indexOf(activeSlide);
								const slides = [...deck.slides];
								[slides[index - 1], slides[index]] = [
									slides[index]!,
									slides[index - 1]!,
								];
								commitDeck({ ...deck, slides });
							}}
						>
							<ArrowUp size={13} />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label="Move slide down"
							disabled={
								disabled ||
								deck.slides.indexOf(activeSlide) === deck.slides.length - 1
							}
							onClick={() => {
								const index = deck.slides.indexOf(activeSlide);
								const slides = [...deck.slides];
								[slides[index], slides[index + 1]] = [
									slides[index + 1]!,
									slides[index]!,
								];
								commitDeck({ ...deck, slides });
							}}
						>
							<ArrowDown size={13} />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label="Duplicate slide"
							disabled={disabled || deck.slides.length >= MAX_SLIDES}
							onClick={() => {
								const duplicate = {
									...activeSlide,
									id: createOutputNodeId("slide"),
									name: `${activeSlide.name} copy`,
									elements: activeSlide.elements.map((element) => ({
										...element,
										id: createOutputNodeId(element.type),
									})),
								};
								commitDeck({
									...deck,
									activeSlideId: duplicate.id,
									slides: [...deck.slides, duplicate],
								});
							}}
						>
							<Copy size={13} />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label="Delete slide"
							disabled={disabled}
							onClick={() => {
								const slides = deck.slides.filter(
									(slide) => slide.id !== activeSlide.id,
								);
								commitDeck({
									...deck,
									slides,
									activeSlideId: slides[0]?.id ?? "slide-1",
								});
							}}
						>
							<Trash size={13} />
						</Button>
					</div>
				</aside>
				<main className="slides-editor-stage grid min-w-0 place-content-center p-3 sm:p-4">
					<SlideCanvas
						slide={activeSlide}
						selectedElementId={selectedElementId}
						disabled={disabled}
						onSelect={(id) => {
							setSelectedElementId(id);
							if (id) {
								setShowInspector(true);
								setShowThumbnails(false);
							}
						}}
						onChangeElement={(next) => updateElement(next, false)}
						onGeometryCommit={(next) => updateElement(next)}
					/>
				</main>
				<aside
					className="slides-editor-chrome slides-editor-inspector grid min-w-0 content-start gap-3 p-3"
					hidden={!showInspector}
				>
					<div>
						<label className="text-kumo-subtle text-xs" htmlFor="slide-name">
							Slide name
						</label>
						<Input
							id="slide-name"
							aria-label="Slide name"
							value={activeSlide.name}
							disabled={disabled}
							onChange={(event) =>
								commitDeck(
									replaceActiveSlide(deck, {
										...activeSlide,
										name: event.target.value.slice(0, 200),
									}),
								)
							}
						/>
					</div>
					<Text as="label" role="label" tone="secondary" className="grid gap-1">
						Background
						<Input
							type="color"
							aria-label="Slide background"
							disabled={disabled}
							value={activeSlide.background}
							onChange={(event) =>
								commitDeck(
									replaceActiveSlide(deck, {
										...activeSlide,
										background: event.target.value,
									}),
								)
							}
						/>
					</Text>
					{selectedElement ? (
						<>
							<Text role="body" weight="medium" className="m-0 capitalize">
								{selectedElement.type}
							</Text>
							<div className="grid grid-cols-2 gap-2">
								{(["x", "y", "width", "height"] as const).map((key) => (
									<Text
										as="label"
										key={key}
										role="label"
										tone="secondary"
										className="grid gap-1"
									>
										<span className="uppercase">{key}</span>
										<Input
											type="number"
											aria-label={`Element ${key}`}
											value={Math.round(selectedElement[key])}
											disabled={disabled}
											onChange={(event) =>
												updateElement({
													...selectedElement,
													[key]: Number(event.target.value),
												})
											}
										/>
									</Text>
								))}
							</div>
							<Text
								as="label"
								role="label"
								tone="secondary"
								className="grid gap-1"
							>
								Font size
								<Input
									type="number"
									aria-label="Element font size"
									min={8}
									max={180}
									value={selectedElement.style.fontSize ?? 24}
									disabled={disabled}
									onChange={(event) =>
										updateElement({
											...selectedElement,
											style: {
												...selectedElement.style,
												fontSize: Number(event.target.value),
											},
										})
									}
								/>
							</Text>
							<Text
								as="label"
								role="label"
								tone="secondary"
								className="grid gap-1"
							>
								Text color
								<Input
									type="color"
									aria-label="Element text color"
									disabled={disabled}
									value={selectedElement.style.color ?? "#222222"}
									onChange={(event) =>
										updateElement({
											...selectedElement,
											style: {
												...selectedElement.style,
												color: event.target.value,
											},
										})
									}
								/>
							</Text>
							<Text
								as="label"
								role="label"
								tone="secondary"
								className="grid gap-1"
							>
								Fill color
								<Input
									type="color"
									aria-label="Element fill color"
									disabled={disabled}
									value={selectedElement.style.background ?? "#ffffff"}
									onChange={(event) =>
										updateElement({
											...selectedElement,
											style: {
												...selectedElement.style,
												background: event.target.value,
											},
										})
									}
								/>
							</Text>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={disabled}
								onClick={() => {
									commitDeck(
										replaceActiveSlide(deck, {
											...activeSlide,
											elements: activeSlide.elements.filter(
												(element) => element.id !== selectedElement.id,
											),
										}),
									);
									setSelectedElementId(null);
								}}
							>
								<Trash size={14} /> Delete element
							</Button>
						</>
					) : (
						<Text role="label" tone="secondary" className="m-0">
							Select an element to edit position, size, typography and color.
							Arrow keys nudge; Shift moves 10 px.
						</Text>
					)}
					<Text as="label" role="label" tone="secondary" className="grid gap-1">
						Speaker notes
						<Textarea
							aria-label="Speaker notes"
							value={activeSlide.notes ?? ""}
							disabled={disabled}
							maxLength={MAX_NOTES_LENGTH}
							onChange={(event) =>
								commitDeck(
									replaceActiveSlide(deck, {
										...activeSlide,
										notes: event.target.value || undefined,
									}),
								)
							}
						/>
					</Text>
				</aside>
			</div>
			{presenting && (
				<div
					className="fixed inset-0 z-50 grid grid-rows-[minmax(0,1fr)_auto] gap-4 bg-(--tedix-presentation-stage) p-4 text-(--tedix-presentation-stage-text)"
					role="dialog"
					aria-modal="true"
					aria-label="Presentation mode"
				>
					<div className="absolute top-4 right-4 z-10 flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							onClick={() => document.documentElement.requestFullscreen?.()}
						>
							<ArrowsOut size={14} /> Full screen
						</Button>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => setPresenting(false)}
						>
							Exit
						</Button>
					</div>
					<div className="slides-present-stage">
						<SlideCanvas
							slide={activeSlide}
							selectedElementId={null}
							disabled
							onSelect={() => {}}
							onChangeElement={() => {}}
							onGeometryCommit={() => {}}
						/>
					</div>
					<div className="flex items-center justify-center gap-3">
						<Button
							size="sm"
							variant="secondary"
							aria-label="Previous slide"
							disabled={deck.slides.indexOf(activeSlide) === 0}
							onClick={() => {
								const previous =
									deck.slides[deck.slides.indexOf(activeSlide) - 1];
								if (previous)
									commitDeck({ ...deck, activeSlideId: previous.id });
							}}
						>
							<ArrowLeft size={16} />
						</Button>
						<span>
							{deck.slides.indexOf(activeSlide) + 1} / {deck.slides.length}
						</span>
						<Button
							size="sm"
							variant="secondary"
							aria-label="Next slide"
							disabled={
								deck.slides.indexOf(activeSlide) === deck.slides.length - 1
							}
							onClick={() => {
								const next = deck.slides[deck.slides.indexOf(activeSlide) + 1];
								if (next) commitDeck({ ...deck, activeSlideId: next.id });
							}}
						>
							<ArrowRight size={16} />
						</Button>
					</div>
				</div>
			)}
			<EditorTextDialog
				open={assetElementType !== null}
				title={
					assetElementType === "svg" ? "Insert SVG or image" : "Insert image"
				}
				description="Add the visual element to the current slide from a URL."
				fieldLabel={
					assetElementType === "svg" ? "SVG or image URL" : "Image URL"
				}
				initialValue="https://"
				submitLabel="Insert"
				maxLength={2_048}
				placeholder="https://example.com/image.png"
				onOpenChange={(open) => {
					if (!open) setAssetElementType(null);
				}}
				onSubmit={(src) => {
					if (assetElementType) insertElement(assetElementType, src);
				}}
			/>
		</div>
	);
}
