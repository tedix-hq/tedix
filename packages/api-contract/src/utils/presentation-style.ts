import type { OsPresentationElement } from "../schemas/os-workspaces";

export function presentationCanvasLength(value: number): string {
	return `calc(${value} * 100cqw / 1200)`;
}

/** Shared by slide editors, viewers and fixed-size PDF/PNG exports. */
export function slideElementStyle(
	element: OsPresentationElement,
	sizing: "canvas" | "pixels" = "canvas",
) {
	const { style } = element;
	const fontSize = style.fontSize ?? 24;
	const length =
		sizing === "pixels"
			? (value: number) => `${value}px`
			: presentationCanvasLength;
	return {
		left:
			sizing === "pixels" ? length(element.x) : `${(element.x / 1200) * 100}%`,
		top:
			sizing === "pixels" ? length(element.y) : `${(element.y / 675) * 100}%`,
		width:
			sizing === "pixels"
				? length(element.width)
				: `${(element.width / 1200) * 100}%`,
		height:
			sizing === "pixels"
				? length(element.height)
				: `${(element.height / 675) * 100}%`,
		fontFamily: style.fontFamily,
		fontSize: length(fontSize),
		lineHeight: fontSize >= 40 ? 1.1 : 1.3,
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
		borderWidth: style.borderWidth ? length(style.borderWidth) : undefined,
		borderRadius: style.borderRadius ? length(style.borderRadius) : undefined,
		textAlign: style.textAlign,
		opacity: style.opacity,
		transform: style.rotation ? `rotate(${style.rotation}deg)` : undefined,
		padding: 0,
	};
}
