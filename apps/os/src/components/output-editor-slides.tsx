import { slideElementStyle } from "@tedix/api-contract/utils/presentation-style";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUDownLeft,
	ArrowUDownRight,
	ArrowUp,
	ArrowsOut,
	Copy,
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
import { useState } from "react";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import {
	insertSlideAfter,
	SlideList,
	templateSlide,
} from "@/components/output-editor-slide-list";
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
import {
	ReadOnlyElement,
	SLIDE_ELEMENT_CLASS,
	useSlideElementFont,
} from "@/components/output-slide-element";
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
	projectDeck,
	type PresentationContent,
	safeImageSource,
} from "@/lib/output-models";
import { useEditorHistory } from "@/lib/use-editor-history";
import {
	applySlideElementAction,
	type SlideElementAction,
	slideElementShortcut,
} from "@/components/slide-element-actions";

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
	useSlideElementFont(current.style.fontFamily);
	const imageSource = safeImageSource(current.src);
	const startGesture = (mode: "move" | "resize", event: React.PointerEvent) => {
		if (disabled) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		onSelect();
		const elementNode = (event.currentTarget as HTMLElement).closest(
			"[data-element]",
		) as HTMLElement | null;
		// The prevented pointerdown also prevents focus, so focus the element
		// explicitly: keyboard nudge, delete and undo need it to follow the click.
		elementNode?.focus({ preventScroll: true });
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
			data-slide-element={element.id}
			className={`${SLIDE_ELEMENT_CLASS} outline-none ${selected ? "ring-2 ring-kumo-focus ring-offset-2" : "focus-visible:ring-2 focus-visible:ring-kumo-focus"}`}
			style={slideElementStyle(current)}
			onClick={(event) => {
				event.stopPropagation();
				onSelect();
			}}
			onKeyDown={(event) => {
				// Keys typed in the element's textarea bubble here; selecting on them
				// swallowed every line break and space.
				if (event.target !== event.currentTarget) return;
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
			{(current.type === "image" || current.type === "svg") && imageSource ? (
				<img
					src={imageSource}
					alt={current.text ?? "Slide visual"}
					className="h-full w-full object-contain"
				/>
			) : current.type === "divider" || current.type === "shape" ? null : (
				// A bare textarea, not the Kumo one: Kumo's `type-tedix-body` forces a
				// 14px size and a 20px line height with `!important`, so the stage drew
				// every slide's text at UI size inside boxes scaled to the slide.
				// `.slide-element-input` resets it to inherit the shared element style.
				<textarea
					aria-label={`${current.type} text`}
					className="slide-element-input"
					disabled={disabled}
					value={current.text ?? ""}
					onPointerDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						(event.currentTarget.parentElement as HTMLElement).focus();
					}}
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
	// Which slide is on the stage is this viewer's state, not the document's.
	// Writing `activeSlideId` on every click made browsing a deck an edit: the
	// draft no longer matched its saved version, so the next saved version was
	// held behind a recovery prompt. Only structural edits (add, duplicate,
	// delete) still record it.
	const [viewedSlideId, setViewedSlideId] = useState<string | null>(null);
	const activeSlide =
		deck.slides.find((slide) => slide.id === viewedSlideId) ??
		deck.slides.find((slide) => slide.id === deck.activeSlideId) ??
		deck.slides[0] ??
		null;
	const [selectedElementId, setSelectedElementId] = useState<string | null>(
		null,
	);
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
	const commitDeck = (next: OsPresentationDeck) => {
		if (next.activeSlideId !== deck.activeSlideId)
			setViewedSlideId(next.activeSlideId);
		history.commit(projectDeck(next));
	};
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
		commitDeck(insertSlideAfter(deck, slide, activeSlide?.id));
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
	const runElementAction = (action: SlideElementAction) => {
		if (!activeSlide) return false;
		const result = applySlideElementAction(
			action,
			activeSlide,
			selectedElement?.id ?? null,
		);
		if (!result) return false;
		if (result.slide) commitDeck(replaceActiveSlide(deck, result.slide));
		setSelectedElementId(result.selectedId);
		return true;
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
			className="slides-editor grid min-w-0 gap-0 outline-none"
			data-editor="presentation-canvas"
			style={{ containerType: "inline-size" }}
			// Focus lands here after a keyboard delete so undo still reaches the editor.
			tabIndex={-1}
			onKeyDown={(event) => {
				const target = event.target as HTMLElement;
				if (
					disabled ||
					target.isContentEditable ||
					["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
				)
					return;
				const key = event.key.toLowerCase();
				if (
					(event.metaKey || event.ctrlKey) &&
					!event.altKey &&
					(key === "z" || (key === "y" && !event.shiftKey))
				) {
					event.preventDefault();
					if (key === "y" || event.shiftKey) history.redo();
					else history.undo();
					return;
				}
				const action = slideElementShortcut(event);
				if (action) {
					if (runElementAction(action)) {
						event.preventDefault();
						// Cut removes the focused element; keep focus in the editor.
						if (action === "cut") event.currentTarget.focus();
					}
					return;
				}
				// Element keys act only on the focused, selected element, so arrows
				// and Backspace keep their meaning in menus, the rail and the toolbar.
				if (
					!selectedElement ||
					target.dataset.slideElement !== selectedElement.id
				)
					return;
				if (event.key === "Escape") {
					event.preventDefault();
					setSelectedElementId(null);
					return;
				}
				if (event.key === "Delete" || event.key === "Backspace") {
					event.preventDefault();
					event.currentTarget.focus();
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
				className="slides-editor-layout grid min-h-0 gap-2"
				data-show-inspector={showInspector || undefined}
				data-show-thumbnails={showThumbnails || undefined}
			>
				<aside
					className="slides-editor-chrome slides-editor-thumbnails grid min-w-0 content-start gap-2 p-2"
					hidden={!showThumbnails}
				>
					<SlideList
						deck={deck}
						activeSlideId={activeSlide.id}
						disabled={disabled}
						maxSlides={MAX_SLIDES}
						onView={(id) => {
							setViewedSlideId(id);
							setSelectedElementId(null);
						}}
						onCommit={(next) => {
							commitDeck(next);
							setSelectedElementId(null);
						}}
					/>
				</aside>
				<main className="slides-editor-stage grid min-w-0 place-content-center p-4 sm:p-6">
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
							<div className="flex gap-1">
								{(
									[
										["duplicate", "Duplicate element", Copy],
										["forward", "Bring forward", ArrowUp],
										["backward", "Send backward", ArrowDown],
										["delete", "Delete element", Trash],
									] as const
								).map(([action, label, Icon]) => (
									<Button
										key={action}
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={label}
										title={label}
										disabled={
											disabled ||
											(action === "forward" &&
												activeSlide.elements.at(-1) === selectedElement) ||
											(action === "backward" &&
												activeSlide.elements[0] === selectedElement)
										}
										onClick={() => runElementAction(action)}
									>
										<Icon size={13} />
									</Button>
								))}
							</div>
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
					onKeyDown={(event) => {
						event.stopPropagation();
						const index = deck.slides.indexOf(activeSlide);
						const target = {
							ArrowRight: index + 1,
							ArrowDown: index + 1,
							PageDown: index + 1,
							" ": index + 1,
							ArrowLeft: index - 1,
							ArrowUp: index - 1,
							PageUp: index - 1,
							Home: 0,
							End: deck.slides.length - 1,
						}[event.key];
						if (event.key === "Escape") setPresenting(false);
						else if (target === undefined) return;
						else {
							const slide = deck.slides[target];
							if (slide) setViewedSlideId(slide.id);
						}
						event.preventDefault();
					}}
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
							autoFocus
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
								if (previous) setViewedSlideId(previous.id);
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
								if (next) setViewedSlideId(next.id);
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
