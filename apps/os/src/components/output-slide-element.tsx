import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect } from "react";
import { safeImageSource } from "@/lib/output-models";
import {
	parseSlideText,
	slideArrowPath,
	slideElementStyle,
} from "@tedix/api-contract/utils/presentation-style";
import { ensureSlideFontLoaded } from "@/lib/slide-fonts";

/** Shared whitespace and wrapping for all slide surfaces. */
export const SLIDE_ELEMENT_CLASS =
	"absolute overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word]";

export function slideImageFitClass(element: OsPresentationElement) {
	return element.style.fit === "cover" ? "object-cover" : "object-contain";
}

export function useSlideElementFont(fontFamily: string | undefined) {
	useEffect(() => ensureSlideFontLoaded(fontFamily), [fontFamily]);
}

export function SlideText({ text }: { text: string }) {
	return parseSlideText(text).map((part, index) =>
		part.bold ? (
			<strong key={index} style={{ fontWeight: 700 }}>
				{part.text}
			</strong>
		) : (
			part.text
		),
	);
}

export function SlideArrow({ element }: { element: OsPresentationElement }) {
	return (
		<svg
			width="100%"
			height="100%"
			viewBox={`0 0 ${element.width} ${element.height}`}
			aria-hidden="true"
			style={{ pointerEvents: "none" }}
		>
			<path
				d={slideArrowPath(element)}
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
			/>
		</svg>
	);
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
					className={`h-full w-full ${slideImageFitClass(element)}`}
				/>
			) : element.type === "arrow" ? (
				<SlideArrow element={element} />
			) : element.type === "divider" || element.type === "shape" ? null : (
				<SlideText text={element.text ?? ""} />
			)}
		</div>
	);
}
