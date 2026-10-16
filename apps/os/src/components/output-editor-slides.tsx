import {
	slideElementStyle,
	slideElementGeometry,
} from "@tedix/api-contract/utils/presentation-style";
import {
	ArrowUDownLeft,
	ArrowUDownRight,
	CaretDown,
	Play,
	Plus,
	SidebarSimple,
	SlidersHorizontal,
} from "@phosphor-icons/react";
import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useRef, useState } from "react";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import {
	insertSlideAfter,
	SlideList,
	templateSlide,
} from "@/components/output-editor-slide-list";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Surface } from "@/components/kumo/surface";
import { Toolbar } from "@/components/kumo/toolbar";
import {
	SlideBackground,
	SlideElementContent,
	SLIDE_ELEMENT_CLASS,
	useSlideElementFont,
	useSlideTextColor,
} from "@/components/output-slide-element";
import {
	bareKey,
	ownsSlideKeys,
	slideNavigationTarget,
} from "@/components/slide-navigation";
import { SlideInspector } from "@/components/slide-inspector";
import { SlidePresenter } from "@/components/slide-presenter";
import {
	EditorHistoryNotice,
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import {
	createOutputNodeId,
	normalizePresentationContent,
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
	projectDeck,
	type PresentationContent,
} from "@/lib/output-models";
import { DECK_HISTORY } from "@/lib/output-history";
import { useEditorHistory } from "@/lib/use-editor-history";
import { usePresentationAppearance } from "@/lib/presentation-appearance";
import {
	applySlideElementAction,
	type SlideElementAction,
	slideElementShortcut,
} from "@/components/slide-element-actions";
import {
	applySnap,
	computeSnapTargets,
	type SnapTargets,
} from "@/components/slide-snap";
import { SlideInsertLibrary } from "@/components/slide-insert-library";
import {
	centeredSlidePosition,
	fileToSlideImageSource,
	slideImageFile,
	slidePointFromClient,
} from "@/lib/slide-image-upload";

const MAX_SLIDES = 200;
/** Screen pixels a press travels before it drags rather than clicks. */
const DRAG_THRESHOLD = 3;
/** The layouts the Add slide caret offers; the button itself adds the first. */
const SLIDE_LAYOUTS = [
	["title-content", "Title + content"],
	["title", "Title"],
	["two-column", "Two column"],
	["four-card", "Four card"],
	["blank", "Blank"],
] as const satisfies readonly (readonly [
	OsPresentationCanvasSlide["layout"],
	string,
])[];
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
	"logo",
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
		style: { background: "#e5e5e5", borderRadius: 2 },
	},
	arrow: {
		width: 300,
		height: 40,
		text: "→",
		style: { fontSize: 56, color: "#222222", textAlign: "center" },
	},
	logo: {
		width: 200,
		height: 60,
		style: { fontSize: 24, fontWeight: "semibold" },
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
	others,
	selected,
	disabled,
	onSelect,
	onChange,
	onGeometryCommit,
}: {
	element: OsPresentationElement;
	others: readonly OsPresentationElement[];
	selected: boolean;
	disabled?: boolean;
	onSelect: () => void;
	onChange: (next: OsPresentationElement) => void;
	onGeometryCommit: (next: OsPresentationElement) => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [editing, setEditing] = useState(false);
	const organization = usePresentationAppearance();
	const [gesture, setGesture] = useState<null | {
		mode: "move" | "resize";
		startX: number;
		startY: number;
		origin: OsPresentationElement;
		dx: number;
		dy: number;
		scale: number;
		// A press becomes a drag only past DRAG_THRESHOLD, so a click still
		// selects, and a click on the selected element starts text editing.
		dragging: boolean;
		wasSelected: boolean;
		snap: boolean;
		targets: SnapTargets;
	}>(null);
	const clampX = (x: number) =>
		Math.max(0, Math.min(PRESENTATION_WIDTH - element.width, x));
	const clampY = (y: number) =>
		Math.max(0, Math.min(PRESENTATION_HEIGHT - element.height, y));
	const moved =
		gesture?.mode === "move" && gesture.dragging
			? (() => {
					const box = {
						x: clampX(gesture.origin.x + gesture.dx / gesture.scale),
						y: clampY(gesture.origin.y + gesture.dy / gesture.scale),
						width: element.width,
						height: element.height,
					};
					if (!gesture.snap) return { ...box, guidesV: [], guidesH: [] };
					const snapped = applySnap(box, gesture.targets);
					return { ...snapped, x: clampX(snapped.x), y: clampY(snapped.y) };
				})()
			: null;
	const geometry =
		gesture?.mode === "resize"
			? {
					...element,
					width: Math.max(
						24,
						Math.min(
							PRESENTATION_WIDTH - element.x,
							gesture.origin.width + gesture.dx / gesture.scale,
						),
					),
					height: Math.max(
						24,
						Math.min(
							PRESENTATION_HEIGHT - element.y,
							gesture.origin.height + gesture.dy / gesture.scale,
						),
					),
				}
			: moved
				? { ...element, x: Math.round(moved.x), y: Math.round(moved.y) }
				: element;
	const current = slideElementGeometry(element, geometry);
	useSlideElementFont(current.style.fontFamily);
	const startGesture = (mode: "move" | "resize", event: React.PointerEvent) => {
		if (disabled || event.button !== 0) return;
		// Preventing the press also keeps the textarea from taking focus and
		// starting a text selection, so a press on the element body drags it.
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
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
			dragging: mode === "resize",
			wasSelected: selected,
			snap: !event.altKey,
			targets: computeSnapTargets(
				others,
				PRESENTATION_WIDTH,
				PRESENTATION_HEIGHT,
			),
		});
	};
	const moveGesture = (event: React.PointerEvent) =>
		setGesture((active) => {
			if (!active) return active;
			const dx = event.clientX - active.startX;
			const dy = event.clientY - active.startY;
			return {
				...active,
				dx,
				dy,
				dragging:
					active.dragging ||
					Math.abs(dx) > DRAG_THRESHOLD ||
					Math.abs(dy) > DRAG_THRESHOLD,
				// Alt/Option turns snapping off, to place an element just off a guide.
				snap: !event.altKey,
			};
		});
	/** Puts the caret where the selected element was clicked. */
	const editText = (clientX: number, clientY: number) => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.focus({ preventScroll: true });
		const caret = document.caretPositionFromPoint?.(clientX, clientY);
		const offset =
			caret?.offsetNode === textarea ? caret.offset : textarea.value.length;
		textarea.setSelectionRange(offset, offset);
	};
	const endGesture = (event: React.PointerEvent) => {
		if (!gesture) return;
		setGesture(null);
		if (gesture.dragging) {
			if (gesture.dx !== 0 || gesture.dy !== 0) onGeometryCommit(current);
		} else if (gesture.wasSelected) editText(event.clientX, event.clientY);
	};
	return (
		<>
			<div
				data-element={element.type}
				aria-label={`${element.type} element`}
				role="group"
				tabIndex={disabled ? -1 : 0}
				data-slide-element={element.id}
				data-selected={selected || undefined}
				className={`${SLIDE_ELEMENT_CLASS} outline-none ${selected ? "ring-2 ring-kumo-focus ring-offset-2" : "focus-visible:ring-2 focus-visible:ring-kumo-focus"}`}
				style={slideElementStyle(current, "canvas", organization)}
				onClick={(event) => {
					event.stopPropagation();
					onSelect();
				}}
				onDoubleClick={(event) => {
					if (disabled) return;
					event.stopPropagation();
					onSelect();
					editText(event.clientX, event.clientY);
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
					// Text being edited keeps its caret and text selection; any other
					// press on the element selects it, drags it, or starts editing.
					if (
						event.target === textareaRef.current &&
						document.activeElement === textareaRef.current
					)
						return;
					startGesture("move", event);
				}}
				onPointerMove={moveGesture}
				onPointerUp={endGesture}
			>
				{!editing && <SlideElementContent element={current} />}
				{!disabled &&
					[
						"title",
						"subtitle",
						"text",
						"bullet",
						"label",
						"card",
						"box",
					].includes(current.type) &&
					!current.props?.title &&
					!current.props?.body && (
						// A bare textarea, not the Kumo one: Kumo's `type-tedix-body` forces a
						// 14px size and a 20px line height with `!important`, so the stage drew
						// every slide's text at UI size inside boxes scaled to the slide.
						// `.slide-element-input` resets it to inherit the shared element style.
						<textarea
							ref={textareaRef}
							aria-label={`${current.type} text`}
							className="slide-element-input"
							style={{
								position: "absolute",
								inset: 0,
								opacity: editing ? 1 : 0,
								padding: "inherit",
							}}
							onFocus={() => setEditing(true)}
							onBlur={() => setEditing(false)}
							disabled={disabled}
							value={current.text ?? ""}
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
			{moved?.guidesV.map((x) => (
				<div
					key={`v${x}`}
					data-snap-guide="vertical"
					className="pointer-events-none absolute inset-y-0 z-50 w-px -translate-x-1/2 bg-kumo-focus"
					style={{ left: `${(x / PRESENTATION_WIDTH) * 100}%` }}
				/>
			))}
			{moved?.guidesH.map((y) => (
				<div
					key={`h${y}`}
					data-snap-guide="horizontal"
					className="pointer-events-none absolute inset-x-0 z-50 h-px -translate-y-1/2 bg-kumo-focus"
					style={{ top: `${(y / PRESENTATION_HEIGHT) * 100}%` }}
				/>
			))}
		</>
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
	const color = useSlideTextColor();
	return (
		<div
			className="slides-editor-canvas relative overflow-hidden"
			style={{
				background: slide.background,
				color,
				containerType: "inline-size",
			}}
			onClick={() => onSelect(null)}
		>
			<SlideBackground slide={slide} />
			{slide.elements.map((element) => (
				<SlideElementView
					key={element.id}
					element={element}
					others={slide.elements.filter((other) => other.id !== element.id)}
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
	const [imageError, setImageError] = useState<string | null>(null);
	const history = useEditorHistory(normalized, onChange, DECK_HISTORY);
	const selectedElement =
		activeSlide?.elements.find((element) => element.id === selectedElementId) ??
		null;
	const commitDeck = (next: OsPresentationDeck) => {
		if (next.activeSlideId !== deck.activeSlideId)
			setViewedSlideId(next.activeSlideId);
		history.commit(projectDeck(next));
	};
	// Every element edit is an undo step; typing into one element coalesces.
	const updateElement = (next: OsPresentationElement) => {
		if (!activeSlide) return;
		const nextDeck = replaceActiveSlide(deck, {
			...activeSlide,
			elements: activeSlide.elements.map((element) =>
				element.id === next.id ? slideElementGeometry(element, next) : element,
			),
		});
		commitDeck(nextDeck);
	};
	const addTemplate = (layout: OsPresentationCanvasSlide["layout"]) => {
		if (deck.slides.length >= MAX_SLIDES) return;
		const slide = templateSlide(layout, deck.slides.length);
		commitDeck(insertSlideAfter(deck, slide, activeSlide?.id));
		setSelectedElementId(slide.elements[0]?.id ?? null);
	};
	const insertElement = (
		type: OsPresentationElementType,
		src?: string,
		center = { x: PRESENTATION_WIDTH / 2, y: PRESENTATION_HEIGHT / 2 },
		text?: string,
	) => {
		if (!activeSlide) return;
		const element = createElement(type, activeSlide.elements.length);
		Object.assign(element, centeredSlidePosition(center, element));
		if (src) element.src = src;
		if (text) element.text = text;
		commitDeck(
			replaceActiveSlide(deck, {
				...activeSlide,
				elements: [...activeSlide.elements, element],
			}),
		);
		setSelectedElementId(element.id);
		setShowInspector(true);
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
	const readImageFile = async (file: File) => {
		setImageError(null);
		try {
			return await fileToSlideImageSource(file);
		} catch (error) {
			setImageError(
				error instanceof Error ? error.message : "The image could not be read.",
			);
			return null;
		}
	};
	const insertImageFile = async (
		file: File,
		center?: { x: number; y: number },
	) => {
		const src = await readImageFile(file);
		if (src)
			insertElement(
				file.type === "image/svg+xml" ? "svg" : "image",
				src,
				center,
				file.name.replace(/\.[^.]+$/, "").slice(0, 200) || undefined,
			);
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
			// Leaving a field ends its undo step.
			onBlur={history.seal}
			onPaste={(event) => {
				const target = event.target as HTMLElement;
				if (
					disabled ||
					target.isContentEditable ||
					["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
				)
					return;
				const file = slideImageFile(event.clipboardData);
				if (!file) return;
				event.preventDefault();
				void insertImageFile(file);
			}}
			onKeyDown={(event) => {
				const target = event.target as HTMLElement;
				// Slide keys apply when no element is selected and the key does not
				// belong to a control: F presents, and the navigation keys change
				// slides. With an element selected, the arrows nudge it instead.
				if (!ownsSlideKeys(target)) {
					if (bareKey(event) === "f") {
						event.preventDefault();
						setPresenting(true);
						return;
					}
					const slideTarget =
						selectedElement ||
						event.key.startsWith("ArrowU") ||
						event.key === "ArrowDown"
							? null
							: slideNavigationTarget(
									event.key,
									deck.slides.indexOf(activeSlide),
									deck.slides.length,
								);
					if (slideTarget !== null) {
						event.preventDefault();
						setViewedSlideId(deck.slides[slideTarget]!.id);
						return;
					}
				}
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
				<EditorHistoryNotice notice={history.notice} />
				<EditorToolbarDivider />
				{/* Split button: one click adds the standard content slide; the
				    caret picks another layout. */}
				<div className="slides-add-split flex items-center">
					<Toolbar.Button
						type="button"
						disabled={disabled}
						onClick={() => addTemplate("title-content")}
					>
						<Plus size={14} /> Add slide
					</Toolbar.Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={disabled}
							render={
								<Toolbar.Button type="button" aria-label="New slide template" />
							}
						>
							<CaretDown size={12} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{SLIDE_LAYOUTS.map(([layout, label]) => (
								<DropdownMenuItem
									key={layout}
									onClick={() => addTemplate(layout)}
								>
									{label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<SlideInsertLibrary
					disabled={disabled}
					onInsert={addElement}
					onUploadImage={(file) => void insertImageFile(file)}
				/>
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
					onClick={() => setShowThumbnails((visible) => !visible)}
				>
					<SidebarSimple size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Inspector"
					active={showInspector}
					onClick={() => setShowInspector((visible) => !visible)}
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
			{imageError && (
				<p role="alert" className="m-0 px-2 py-1 text-kumo-danger text-xs">
					{imageError}
				</p>
			)}
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
				<main
					className="slides-editor-stage grid min-w-0 place-content-center p-4 sm:p-6"
					// Elements stop their own clicks, so this is a click on empty stage.
					onClick={() => setSelectedElementId(null)}
					onPointerDown={(event) => {
						// A press on the empty stage hands the keyboard to the editor,
						// so slide navigation and F work right after deselecting.
						if (!(event.target as HTMLElement).closest("[data-slide-element]"))
							(
								event.currentTarget.closest(
									'[data-editor="presentation-canvas"]',
								) as HTMLElement | null
							)?.focus({ preventScroll: true });
					}}
					onDragOver={(event) => {
						if (disabled || !event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}}
					onDrop={(event) => {
						const file = disabled ? null : slideImageFile(event.dataTransfer);
						if (!file) return;
						event.preventDefault();
						const canvas = event.currentTarget.querySelector(
							".slides-editor-canvas",
						);
						void insertImageFile(
							file,
							canvas
								? slidePointFromClient(
										event.clientX,
										event.clientY,
										canvas.getBoundingClientRect(),
									)
								: undefined,
						);
					}}
				>
					<SlideCanvas
						slide={activeSlide}
						selectedElementId={selectedElementId}
						disabled={disabled}
						onSelect={(id) => {
							setSelectedElementId(id);
						}}
						onChangeElement={(next) => updateElement(next)}
						onGeometryCommit={(next) => updateElement(next)}
					/>
				</main>
				<aside
					className="slides-editor-chrome slides-editor-inspector grid min-w-0"
					hidden={!showInspector}
				>
					<SlideInspector
						slide={activeSlide}
						element={selectedElement}
						disabled={disabled}
						canMoveForward={activeSlide.elements.at(-1) !== selectedElement}
						canMoveBackward={activeSlide.elements[0] !== selectedElement}
						onChangeSlide={(next) => commitDeck(replaceActiveSlide(deck, next))}
						onChangeElement={(next) => updateElement(next)}
						onAction={runElementAction}
						onImageFile={async (file) => {
							const src = await readImageFile(file);
							if (src && selectedElement)
								updateElement({ ...selectedElement, src });
						}}
						onBackgroundImageFile={async (file) => {
							const backgroundImage = await readImageFile(file);
							if (backgroundImage)
								commitDeck(
									replaceActiveSlide(deck, { ...activeSlide, backgroundImage }),
								);
						}}
					/>
				</aside>
			</div>
			{presenting && (
				<SlidePresenter
					deck={deck}
					slideId={activeSlide.id}
					onNavigate={setViewedSlideId}
					onExit={() => setPresenting(false)}
					hasSelection={selectedElementId !== null}
					onDeselect={() => setSelectedElementId(null)}
				/>
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
