import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { type CSSProperties, useEffect } from "react";
import {
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
	presentationCanvasLength,
	presentationLineHeight,
	safeImageSource,
} from "@/lib/output-models";
import { ensureSlideFontLoaded } from "@/lib/slide-fonts";

/**
 * The one slide element style, shared by every surface that draws a slide:
 * the editor stage, present mode, the read view canvas and both rails.
 *
 * Every length is authored in the 1200x675 reference canvas. Position and size
 * become percentages of the canvas; type, borders and radii go through
 * {@link presentationCanvasLength}, i.e. `cqw`, so one markup scales from a
 * full stage down to a 176px thumbnail untouched. Any container rendering it
 * must therefore establish an inline-size container, or the lengths resolve
 * against whichever ancestor does.
 *
 * Line height, weight and tracking are set here, never inherited. It used to come from whatever
 * wrapped the canvas -- the page body in the read view, a Kumo button in the
 * rails -- so the same deck sat at a different baseline, and in the rails at medium
 * weight, on each surface.
 */
export function slideElementStyle(
	element: OsPresentationElement,
): CSSProperties {
	const { style } = element;
	const fontSize = style.fontSize ?? 24;
	return {
		left: `${(element.x / PRESENTATION_WIDTH) * 100}%`,
		top: `${(element.y / PRESENTATION_HEIGHT) * 100}%`,
		width: `${(element.width / PRESENTATION_WIDTH) * 100}%`,
		height: `${(element.height / PRESENTATION_HEIGHT) * 100}%`,
		fontFamily: style.fontFamily,
		fontSize: presentationCanvasLength(fontSize),
		lineHeight: presentationLineHeight(fontSize),
		fontWeight:
			style.fontWeight === "semibold"
				? 600
				: style.fontWeight === "medium"
					? 500
					: (style.fontWeight ?? "normal"),
		letterSpacing: "normal",
		color: style.color,
		background: style.background,
		borderColor: style.borderColor,
		borderStyle: style.borderWidth ? "solid" : undefined,
		borderWidth: style.borderWidth
			? presentationCanvasLength(style.borderWidth)
			: undefined,
		borderRadius: style.borderRadius
			? presentationCanvasLength(style.borderRadius)
			: undefined,
		textAlign: style.textAlign,
		opacity: style.opacity,
		transform: style.rotation ? `rotate(${style.rotation}deg)` : undefined,
		padding: 0,
	};
}

/** Text wraps the way an editing textarea does, so editing never reflows. */
export const SLIDE_ELEMENT_CLASS =
	"absolute overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word]";

export function useSlideElementFont(fontFamily: string | undefined) {
	useEffect(() => ensureSlideFontLoaded(fontFamily), [fontFamily]);
}

/**
 * The read-only element: the committed deck canvas, the read view rail, and
 * the editor rail. The editor stage renders the same {@link slideElementStyle}
 * box with an editable textarea inside.
 */
export function ReadOnlyElement({
	element,
}: {
	element: OsPresentationElement;
}) {
	const src = safeImageSource(element.src);
	useSlideElementFont(element.style.fontFamily);
	return (
		<div
			className={SLIDE_ELEMENT_CLASS}
			data-slide-element={element.id}
			style={slideElementStyle(element)}
		>
			{(element.type === "image" || element.type === "svg") && src ? (
				<img
					src={src}
					alt={element.text ?? "Slide visual"}
					className="h-full w-full object-contain"
				/>
			) : element.type === "divider" || element.type === "shape" ? null : (
				element.text
			)}
		</div>
	);
}
