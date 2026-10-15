import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect } from "react";
import { safeImageSource } from "@/lib/output-models";
import { slideElementStyle } from "@tedix/api-contract/utils/presentation-style";
import { ensureSlideFontLoaded } from "@/lib/slide-fonts";

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
