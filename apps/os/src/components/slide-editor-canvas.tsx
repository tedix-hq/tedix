import {
	slideElementStyle,
	slideElementGeometry,
} from "@tedix/api-contract/utils/presentation-style";
import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useRef, useState } from "react";
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

export function SlideCanvas({
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
