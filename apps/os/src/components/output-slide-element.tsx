import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect } from "react";
import { ensureSlideFontLoaded } from "@/lib/slide-fonts";
import {
	slideBackgroundMarkup,
	slideElementMarkup,
	slideElementStyle,
} from "@tedix/api-contract/utils/presentation-style";
import { usePresentationAppearance } from "@/lib/presentation-appearance";

export function useSlideTextColor() {
	const { appearance } = usePresentationAppearance();
	return (
		appearance?.slideTones?.neutral ?? appearance?.light.foreground ?? "#111111"
	);
}

export function SlideBackground({
	slide,
}: {
	slide: OsPresentationCanvasSlide;
}) {
	const organization = usePresentationAppearance();
	return (
		<div
			style={{ display: "contents" }}
			dangerouslySetInnerHTML={{
				__html: slideBackgroundMarkup(slide, "canvas", organization),
			}}
		/>
	);
}

export function SlideElementContent({
	element,
}: {
	element: OsPresentationElement;
}) {
	const organization = usePresentationAppearance();
	return (
		<div
			style={{ display: "contents" }}
			dangerouslySetInnerHTML={{
				__html: slideElementMarkup(element, "canvas", organization),
			}}
		/>
	);
}

/** Shared whitespace and wrapping for all slide surfaces. */
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
	const organization = usePresentationAppearance();
	useSlideElementFont(element.style.fontFamily);
	return (
		<div
			className={SLIDE_ELEMENT_CLASS}
			data-slide-element={element.id}
			style={slideElementStyle(element, "canvas", organization)}
		>
			<SlideElementContent element={element} />
		</div>
	);
}

export function ReadOnlySlide({
	slide,
	className,
}: {
	slide: OsPresentationCanvasSlide;
	className: string;
}) {
	const color = useSlideTextColor();
	return (
		<div
			className={className}
			style={{
				background: slide.background,
				color,
				containerType: "inline-size",
			}}
		>
			<SlideBackground slide={slide} />
			{slide.elements.map((element) => (
				<ReadOnlyElement key={element.id} element={element} />
			))}
		</div>
	);
}
