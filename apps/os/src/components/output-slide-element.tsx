import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import {
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
	presentationCanvasLength,
	safeImageSource,
} from "@/lib/output-models";

/**
 * The one read-only slide element renderer, shared by every surface that shows
 * a slide it cannot edit: the committed deck canvas, the read view rail, and
 * the editor rail.
 *
 * It positions in percentages of the 1200x675 reference canvas and sizes type
 * with {@link presentationCanvasLength}, i.e. in `cqw`, so the same markup
 * scales from a full stage down to a 176px thumbnail untouched. Any container
 * rendering it must therefore establish an inline-size container, or the type
 * resolves against whichever ancestor does.
 *
 * The editor rail used to carry its own inline approximation instead: a span
 * pinned to a fixed four-pixel type size with only background and colour, which
 * ignored weight, alignment, opacity, rotation and borders, and dropped images
 * entirely. Two renderers for one artifact is exactly the drift this module
 * exists to prevent. (The literal is spelled out in words deliberately --
 * `lint:kumo` scans for arbitrary type literals as text and cannot tell
 * a comment from a class.)
 */
export function ReadOnlyElement({
	element,
}: {
	element: OsPresentationElement;
}) {
	const src = safeImageSource(element.src);
	return (
		<div
			className="absolute overflow-hidden whitespace-pre-line"
			style={{
				left: `${(element.x / PRESENTATION_WIDTH) * 100}%`,
				top: `${(element.y / PRESENTATION_HEIGHT) * 100}%`,
				width: `${(element.width / PRESENTATION_WIDTH) * 100}%`,
				height: `${(element.height / PRESENTATION_HEIGHT) * 100}%`,
				fontFamily: element.style.fontFamily,
				fontSize: presentationCanvasLength(element.style.fontSize ?? 24),
				fontWeight:
					element.style.fontWeight === "semibold"
						? 600
						: element.style.fontWeight === "medium"
							? 500
							: element.style.fontWeight,
				color: element.style.color,
				background: element.style.background,
				borderColor: element.style.borderColor,
				borderWidth: element.style.borderWidth,
				borderRadius: element.style.borderRadius,
				textAlign: element.style.textAlign,
				opacity: element.style.opacity,
				transform: element.style.rotation
					? `rotate(${element.style.rotation}deg)`
					: undefined,
				padding: 0,
			}}
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
