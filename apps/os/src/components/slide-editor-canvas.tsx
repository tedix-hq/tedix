import {
	slideElementStyle,
	slideElementGeometry,
} from "@tedix/api-contract/utils/presentation-style";
import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { type Ref, useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	SlideBackground,
	SlideElementContent,
	SLIDE_ELEMENT_CLASS,
	useSlideElementFont,
	useSlideTextColor,
} from "@/components/output-slide-element";
import { PRESENTATION_WIDTH, PRESENTATION_HEIGHT } from "@/lib/output-models";
import { usePresentationAppearance } from "@/lib/presentation-appearance";
import {
	applySnap,
	computeSnapTargets,
	type SnapTargets,
} from "@/components/slide-snap";

/** Screen pixels a press travels before it drags rather than clicks. */
const DRAG_THRESHOLD = 3;

/** The element types whose text edits inline on the stage. */
const TEXT_ELEMENT_TYPES: readonly OsPresentationElementType[] = [
	"title",
	"subtitle",
	"text",
	"bullet",
	"label",
	"card",
	"box",
];

const IMAGE_ELEMENT_TYPES: readonly OsPresentationElementType[] = [
	"image",
	"svg",
];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * The image overflow on one axis, in screen pixels: the difference between
 * the element box and the rendered image under its object-fit. Negative when
 * the image overflows (cover); `object-position` maps a 0-1 focal fraction
 * onto this slack, so a pointer delta converts with `dx / slack`.
 */
function imageSlack(elementNode: HTMLElement, fit: "contain" | "cover") {
	const image = elementNode.querySelector("img");
	const box = elementNode.getBoundingClientRect();
	const naturalWidth = image?.naturalWidth ?? 0,
		naturalHeight = image?.naturalHeight ?? 0;
	if (!naturalWidth || !naturalHeight || !box.width || !box.height)
		return { x: 0, y: 0 };
	const scale =
		fit === "cover"
			? Math.max(box.width / naturalWidth, box.height / naturalHeight)
			: Math.min(box.width / naturalWidth, box.height / naturalHeight);
	return {
		x: box.width - naturalWidth * scale,
		y: box.height - naturalHeight * scale,
	};
}

function SlideElementView({
	element,
	others,
	selected,
	cropping,
	disabled,
	onSelect,
	onChange,
	onGeometryCommit,
}: {
	element: OsPresentationElement;
	others: readonly OsPresentationElement[];
	selected: boolean;
	/** Dragging moves the image inside its frame instead of moving the frame. */
	cropping?: boolean;
	disabled?: boolean;
	onSelect: () => void;
	onChange: (next: OsPresentationElement) => void;
	onGeometryCommit: (next: OsPresentationElement) => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [editing, setEditing] = useState(false);
	const [resizeAnnouncement, setResizeAnnouncement] = useState("");
	// A pointer-led edit carries the pressed point so the caret lands there.
	const editPointRef = useRef<{ x: number; y: number } | null>(null);
	const organization = usePresentationAppearance();
	const [gesture, setGesture] = useState<null | {
		mode: "move" | "resize" | "crop";
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
		// Crop drag state: the focal point at press time and the image slack
		// each axis maps to, measured once so the drag tracks the pointer.
		focal?: { x: number; y: number };
		slack?: { x: number; y: number };
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
	const cropFocal =
		gesture?.mode === "crop" && gesture.dragging && gesture.focal
			? {
					x: gesture.slack?.x
						? clamp01(gesture.focal.x + gesture.dx / gesture.slack.x)
						: gesture.focal.x,
					y: gesture.slack?.y
						? clamp01(gesture.focal.y + gesture.dy / gesture.slack.y)
						: gesture.focal.y,
				}
			: null;
	const current = slideElementGeometry(
		element,
		cropFocal
			? { ...geometry, props: { ...geometry.props, focalPoint: cropFocal } }
			: geometry,
	);
	useSlideElementFont(current.style.fontFamily);
	// Card and box elements with structured props edit their text in the
	// inspector instead; the rest take a plain textarea over the element.
	const editable =
		TEXT_ELEMENT_TYPES.includes(current.type) &&
		!current.props?.title &&
		!current.props?.body;
	const canEdit = editable && !disabled;
	// The textarea mounts only when editing starts, so focusing it and placing
	// the caret happen here rather than in the press that began the edit.
	useEffect(() => {
		if (!editing) return;
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.focus({ preventScroll: true });
		const point = editPointRef.current;
		const caret = point
			? document.caretPositionFromPoint?.(point.x, point.y)
			: undefined;
		const offset =
			caret?.offsetNode === textarea ? caret.offset : textarea.value.length;
		textarea.setSelectionRange(offset, offset);
	}, [editing]);
	const startGesture = (
		mode: "move" | "resize" | "crop",
		event: React.PointerEvent,
	) => {
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
			...(mode === "crop"
				? {
						focal: element.props?.focalPoint ?? { x: 0.5, y: 0.5 },
						slack: elementNode
							? imageSlack(elementNode, element.style.fit ?? "contain")
							: { x: 0, y: 0 },
					}
				: {}),
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
	/** Starts inline editing; a press passes its point so the caret lands there. */
	const beginEditing = (clientX?: number, clientY?: number) => {
		if (!canEdit) return;
		editPointRef.current =
			clientX === undefined || clientY === undefined
				? null
				: { x: clientX, y: clientY };
		setEditing(true);
	};
	const endGesture = (event: React.PointerEvent) => {
		if (!gesture) return;
		setGesture(null);
		if (gesture.dragging) {
			if (gesture.dx !== 0 || gesture.dy !== 0) onGeometryCommit(current);
		} else if (gesture.mode === "crop") {
			// A plain press inside a cropping frame pins the focal point there.
			const box = (
				event.currentTarget as HTMLElement
			).getBoundingClientRect();
			if (box.width && box.height)
				onGeometryCommit({
					...element,
					props: {
						...element.props,
						focalPoint: {
							x: clamp01((event.clientX - box.left) / box.width),
							y: clamp01((event.clientY - box.top) / box.height),
						},
					},
				});
		} else if (gesture.wasSelected)
			beginEditing(event.clientX, event.clientY);
	};
	const resizeWithKeyboard = (event: React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			// Hand focus back to the element; its own keys take over from there.
			(
				event.currentTarget.closest(
					"[data-slide-element]",
				) as HTMLElement | null
			)?.focus({ preventScroll: true });
			return;
		}
		const direction: Record<string, [number, number]> = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		const delta = direction[event.key];
		if (!delta) return;
		event.preventDefault();
		event.stopPropagation();
		const amount = event.shiftKey ? 10 : 1;
		const next = {
			...element,
			width: Math.max(
				24,
				Math.min(
					PRESENTATION_WIDTH - element.x,
					element.width + delta[0] * amount,
				),
			),
			height: Math.max(
				24,
				Math.min(
					PRESENTATION_HEIGHT - element.y,
					element.height + delta[1] * amount,
				),
			),
		};
		// A key at the size limit announces the unchanged size but commits nothing.
		if (next.width !== element.width || next.height !== element.height)
			onGeometryCommit(next);
		setResizeAnnouncement(
			`${element.type} element ${Math.round(next.width)} by ${Math.round(next.height)}`,
		);
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
				data-editable={canEdit || undefined}
				data-cropping={cropping || undefined}
				className={`${SLIDE_ELEMENT_CLASS} outline-none ${selected ? "ring-2 ring-kumo-focus ring-offset-2" : "focus-visible:ring-2 focus-visible:ring-kumo-focus"}`}
				style={{
					...slideElementStyle(current, "canvas", organization),
					cursor: cropping ? "move" : undefined,
				}}
				onFocus={(event) => {
					// Tabbing to an element selects it, as a click does, so the arrow
					// keys move it straight away instead of changing slides.
					if (event.target === event.currentTarget && !selected && !disabled)
						onSelect();
				}}
				onClick={(event) => {
					event.stopPropagation();
					onSelect();
				}}
				onDoubleClick={(event) => {
					if (disabled) return;
					event.stopPropagation();
					onSelect();
					beginEditing(event.clientX, event.clientY);
				}}
				onKeyDown={(event) => {
					// Keys typed in the element's textarea bubble here; selecting on them
					// swallowed every line break and space.
					if (event.target !== event.currentTarget) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onSelect();
						// The textarea is not in the tab order, so Enter on the
						// selected element is the keyboard way into inline editing.
						if (event.key === "Enter" && selected) beginEditing();
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
					startGesture(
						cropping && IMAGE_ELEMENT_TYPES.includes(element.type)
							? "crop"
							: "move",
						event,
					);
				}}
				onPointerMove={moveGesture}
				onPointerUp={endGesture}
			>
				{!editing && <SlideElementContent element={current} />}
				{editing && (
					// A bare textarea, not the Kumo one: Kumo's `type-tedix-body` forces a
					// 14px size and a 20px line height with `!important`, so the stage drew
					// every slide's text at UI size inside boxes scaled to the slide.
					// `.slide-element-input` resets it to inherit the shared element style.
					// It mounts only once editing starts: an invisible textarea in the
					// tab order was an extra focus stop that entered edit mode on Tab.
					<textarea
						ref={textareaRef}
						aria-label={`${current.type} text`}
						className="slide-element-input"
						style={{ position: "absolute", inset: 0, padding: "inherit" }}
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
						// Move and release bubble to the element's own handlers; wiring
						// them here too committed every pointer resize twice.
						onPointerDown={(event) => startGesture("resize", event)}
						onKeyDown={resizeWithKeyboard}
					/>
				)}
				{selected && !disabled && (
					<span className="sr-only" aria-live="polite">
						{resizeAnnouncement}
					</span>
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

export function SlideCanvas({
	slide,
	selectedElementId,
	cropElementId,
	disabled,
	onSelect,
	onChangeElement,
	onGeometryCommit,
	ref,
}: {
	slide: OsPresentationCanvasSlide;
	selectedElementId: string | null;
	/** The element whose image is being repositioned inside its frame. */
	cropElementId?: string | null;
	disabled?: boolean;
	onSelect: (id: string | null) => void;
	onChangeElement: (next: OsPresentationElement) => void;
	onGeometryCommit: (next: OsPresentationElement) => void;
	ref?: Ref<HTMLDivElement>;
}) {
	const color = useSlideTextColor();
	return (
		<div
			ref={ref}
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
					cropping={element.id === cropElementId}
					disabled={disabled}
					onSelect={() => onSelect(element.id)}
					onChange={onChangeElement}
					onGeometryCommit={onGeometryCommit}
				/>
			))}
		</div>
	);
}
