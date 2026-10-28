import "./output-editor.css";
import { SlideCanvas } from "@/components/slide-editor-canvas";
import { createElement } from "@/components/slide-element-defaults";
import { slideElementGeometry } from "@tedix/api-contract/utils/presentation-style";
import {
	ArrowUDownLeft,
	ArrowUDownRight,
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
import { useEffect, useRef, useState } from "react";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import {
	insertSlideAfter,
	SlideList,
	slideLabel,
	templateSlide,
} from "@/components/output-editor-slide-list";
import { Button } from "@/components/kumo/button";
import { Surface } from "@/components/kumo/surface";
import { Toolbar } from "@/components/kumo/toolbar";
import {
	bareKey,
	ownsSlideKeys,
	slideNavigationTarget,
} from "@/components/slide-navigation";
import { AddSlideButton } from "@/components/slide-add-button";
import { SLIDE_NAV_ATTRIBUTE, SlideDeckBar } from "@/components/slide-deck-bar";
import { useSlideEntrance, useSlideSwipe } from "@/components/slide-motion";
import { SlideInspector } from "@/components/slide-inspector";
import { SlidePresenter } from "@/components/slide-presenter";
import {
	EditorHistoryNotice,
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import {
	normalizePresentationContent,
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
	projectDeck,
	type PresentationContent,
} from "@/lib/output-models";
import { DECK_HISTORY } from "@/lib/output-history";
import { useEditorHistory } from "@/lib/use-editor-history";
import {
	applySlideElementAction,
	type SlideElementAction,
	slideElementShortcut,
} from "@/components/slide-element-actions";
import { SlideInsertLibrary } from "@/components/slide-insert-library";
import { SlideMediaPicker } from "@/components/slide-media-picker";
import {
	centeredSlidePosition,
	fileToSlideImageSource,
	slideImageFile,
	slidePointFromClient,
} from "@/lib/slide-image-upload";

const MAX_SLIDES = 200;
function replaceActiveSlide(
	deck: OsPresentationDeck,
	next: OsPresentationCanvasSlide,
): OsPresentationDeck {
	return {
		...deck,
		slides: deck.slides.map((slide) => (slide.id === next.id ? next : slide)),
	};
}

interface SlidesEditorProps {
	value: PresentationContent;
	onChange: (next: PresentationContent) => void;
	disabled?: boolean;
	/** The workspace whose files the image picker offers; omitted hides them. */
	workspaceId?: string;
}

/** Where a picked image lands: a new element, the selected one, or the background. */
type MediaTarget = "insert" | "element" | "background";

export function SlidesEditor({
	value,
	onChange,
	disabled = false,
	workspaceId,
}: SlidesEditorProps) {
	const normalized = normalizePresentationContent(value);
	const deck = normalized.deck!;
	const [emptyAnnouncement, setEmptyAnnouncement] = useState("");
	const addSlideRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (emptyAnnouncement && deck.slides.length === 0)
			addSlideRef.current?.focus();
	}, [emptyAnnouncement, deck.slides.length]);
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
	// Reposition mode: drags on the selected image move the picture inside its
	// frame instead of moving the frame. It ends on Escape, a new selection or
	// a slide change.
	const [cropping, setCropping] = useState(false);
	const [mediaTarget, setMediaTarget] = useState<MediaTarget | null>(null);
	const [presenting, setPresenting] = useState(false);
	const [showThumbnails, setShowThumbnails] = useState(true);
	const [showInspector, setShowInspector] = useState(false);
	const [assetElementType, setAssetElementType] = useState<
		"image" | "svg" | null
	>(null);
	const [imageError, setImageError] = useState<string | null>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	const activeIndex = activeSlide ? deck.slides.indexOf(activeSlide) : -1;
	useSlideEntrance(canvasRef, activeSlide?.id, activeIndex);
	const viewSlide = (target: number) => {
		const next = deck.slides[target];
		if (!next) return;
		setViewedSlideId(next.id);
		setSelectedElementId(null);
		setCropping(false);
	};
	const swipe = useSlideSwipe(
		() => viewSlide(activeIndex - 1),
		() => viewSlide(activeIndex + 1),
	);
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
		if (type === "image") {
			setMediaTarget("insert");
			return;
		}
		if (type === "svg") {
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
	const insertImageSource = (
		file: File,
		src: string,
		center?: { x: number; y: number },
	) =>
		insertElement(
			file.type === "image/svg+xml" ? "svg" : "image",
			src,
			center,
			file.name.replace(/\.[^.]+$/, "").slice(0, 200) || undefined,
		);
	const insertImageFile = async (
		file: File,
		center?: { x: number; y: number },
	) => {
		const src = await readImageFile(file);
		if (src) insertImageSource(file, src, center);
	};
	// The picker always resolves to the upload pipeline: a workspace file is
	// downloaded into a File, so embeds, size limits and errors stay uniform.
	const pickImageFile = async (file: File) => {
		const src = await readImageFile(file);
		if (!src) return;
		if (mediaTarget === "element" && selectedElement)
			updateElement({ ...selectedElement, src });
		else if (mediaTarget === "background" && activeSlide)
			commitDeck(
				replaceActiveSlide(deck, { ...activeSlide, backgroundImage: src }),
			);
		else insertImageSource(file, src);
	};

	if (!activeSlide) {
		return (
			<div>
				<Surface
					tier="panel"
					className="grid justify-items-start gap-3 border-dashed p-8"
				>
					<p className="m-0 text-kumo-subtle">
						This presentation has no slides yet.
					</p>
					<Button
						ref={addSlideRef}
						size="sm"
						disabled={disabled}
						onClick={() => addTemplate("title-content")}
					>
						<Plus size={14} /> Add slide
					</Button>
				</Surface>
				<p key="slide-deletion-status" aria-live="polite" className="sr-only">
					{emptyAnnouncement}
				</p>
			</div>
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
				// The stage's slide controls keep Space and Enter but pass arrows on.
				const onNavigator =
					target.closest(`[${SLIDE_NAV_ATTRIBUTE}]`) !== null &&
					event.key !== " " &&
					event.key !== "Enter";
				if (onNavigator || !ownsSlideKeys(target)) {
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
					// Escape leaves reposition mode first; a second one deselects.
					if (cropping) setCropping(false);
					else setSelectedElementId(null);
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
				{/* The rail carries Add slide; while it is closed the toolbar does. */}
				{showThumbnails ? null : (
					<AddSlideButton
						placement="toolbar"
						disabled={disabled}
						onAdd={addTemplate}
					/>
				)}
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
							setEmptyAnnouncement(
								next.slides.length === 0
									? `Deleted ${slideLabel(activeSlide)}. No slides remaining.`
									: "",
							);
							commitDeck(next);
							setSelectedElementId(null);
						}}
					/>
					<AddSlideButton
						placement="rail"
						disabled={disabled || deck.slides.length >= MAX_SLIDES}
						onAdd={addTemplate}
					/>
				</aside>
				<main
					className="slides-editor-stage grid min-w-0 place-content-center p-4 sm:p-6"
					// Elements stop their own clicks, so this is a click on empty stage.
					onClick={() => setSelectedElementId(null)}
					onPointerUp={(event) => {
						// A swipe turns the page on touch; a drag on a block moves it.
						if (!(event.target as HTMLElement).closest("[data-slide-element]"))
							swipe.onPointerUp(event);
					}}
					onPointerCancel={swipe.onPointerCancel}
					onPointerDown={(event) => {
						swipe.onPointerDown(event);
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
						ref={canvasRef}
						slide={activeSlide}
						selectedElementId={selectedElementId}
						cropElementId={cropping ? selectedElementId : null}
						disabled={disabled}
						theme={deck.theme}
						onSelect={(id) => {
							// A press on the image being repositioned keeps that mode.
							if (id !== selectedElementId) setCropping(false);
							setSelectedElementId(id);
						}}
						onChangeElement={(next) => updateElement(next)}
						onGeometryCommit={(next) => updateElement(next)}
					/>
					<SlideDeckBar
						index={activeIndex}
						count={deck.slides.length}
						onPrevious={() => viewSlide(activeIndex - 1)}
						onNext={() => viewSlide(activeIndex + 1)}
						onPresent={() => setPresenting(true)}
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
						cropping={cropping}
						canMoveForward={activeSlide.elements.at(-1) !== selectedElement}
						canMoveBackward={activeSlide.elements[0] !== selectedElement}
						theme={deck.theme}
						onChangeTheme={(theme) => commitDeck({ ...deck, theme })}
						onChangeSlide={(next) => commitDeck(replaceActiveSlide(deck, next))}
						onChangeElement={(next) => updateElement(next)}
						onAction={runElementAction}
						onInsert={addElement}
						onUploadImage={(file) => void insertImageFile(file)}
						onChooseImage={
							selectedElement ? () => setMediaTarget("element") : undefined
						}
						onChooseBackgroundImage={
							workspaceId ? () => setMediaTarget("background") : undefined
						}
						onCropToggle={() => setCropping((active) => !active)}
						onImageFile={async (file) => {
							const src = await readImageFile(file);
							if (src && selectedElement)
								updateElement({ ...selectedElement, src });
						}}
						onBackgroundImageFile={async (file) => {
							const backgroundImage = await readImageFile(file);
							if (backgroundImage)
								commitDeck(
									replaceActiveSlide(deck, {
										...activeSlide,
										backgroundImage,
									}),
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
			<SlideMediaPicker
				workspaceId={workspaceId}
				open={mediaTarget !== null}
				onOpenChange={(open) => {
					if (!open) setMediaTarget(null);
				}}
				onPickFile={(file) => void pickImageFile(file)}
				onPickUrl={
					mediaTarget === "insert"
						? (src) => insertElement("image", src)
						: undefined
				}
			/>
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
			<p key="slide-deletion-status" aria-live="polite" className="sr-only">
				{emptyAnnouncement}
			</p>
		</div>
	);
}
