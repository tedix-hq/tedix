import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
	OsPresentationTheme,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	slideArrowEndpoints,
	slideThemeFontFamily,
	slideTone,
	type PresentationAppearance,
} from "@tedix/api-contract/utils/presentation-style";

export function pptxSlideParts(
	slide: OsPresentationCanvasSlide,
	organization: PresentationAppearance,
	theme?: OsPresentationTheme,
): OsPresentationElement[] {
	const parts: OsPresentationElement[] = [];
	if (slide.backgroundImage)
		parts.push({
			id: "cover",
			type: "image",
			src: slide.backgroundImage,
			x: 0,
			y: 0,
			width: 1200,
			height: 675,
			style: { fit: "cover" },
		});
	if (slide.dotGridOpacity) {
		const color = slideTone("neutral", organization).color;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><defs><pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1" fill="${color}" opacity="${slide.dotGridOpacity}"/></pattern></defs><rect width="1200" height="675" fill="url(#dots)"/></svg>`;
		parts.push({
			id: "dots",
			type: "image",
			src: `data:image/svg+xml;base64,${btoa(svg)}`,
			x: 0,
			y: 0,
			width: 1200,
			height: 675,
			style: {},
		});
	}
	if (slide.insetSurface) {
		const { inset, color, radius } = slide.insetSurface;
		parts.push({
			id: "surface",
			type: "shape",
			x: inset,
			y: inset,
			width: 1200 - 2 * inset,
			height: 675 - 2 * inset,
			style: { background: color, borderRadius: radius },
		});
	}
	for (const element of slide.elements) {
		const tone = slideTone(element.props?.tone, organization);
		const container = element.type === "card" || element.type === "box";
		const pill = element.type === "label" && element.props?.tone;
		const resolved: OsPresentationElement = {
			...element,
			style: {
				...element.style,
				fontFamily: slideThemeFontFamily(element, theme),
				background:
					element.style.background ??
					(container || pill ? tone.fill : undefined),
				color: element.style.color ?? (pill ? tone.color : undefined),
				borderColor:
					element.style.borderColor ?? (container ? tone.border : undefined),
				borderWidth: element.style.borderWidth ?? (container ? 1 : undefined),
				borderStyle: element.props?.dashed
					? "dashed"
					: element.style.borderStyle,
				borderRadius:
					element.props?.radius ??
					element.style.borderRadius ??
					(pill ? 600 : container ? 2 : undefined),
			},
		};
		if (element.type === "logo") {
			parts.push({
				...resolved,
				type: organization.logoUrl ? "image" : "text",
				src: organization.logoUrl ?? undefined,
				text: organization.name ?? "",
			});
		} else if (container) {
			parts.push({ ...resolved, type: "shape", text: undefined });
			const card = element.type === "card",
				padding = card ? 20 : 14;
			const definitions = [
				{
					text: element.props?.eyebrow,
					size: 10,
					weight: "semibold" as const,
					color: slideTone("accent", organization).color,
					lineHeight: 1.2,
				},
				{
					text: element.props?.title ?? element.text,
					size: card ? 18 : 16,
					weight: "semibold" as const,
					color:
						element.style.color ?? slideTone("neutral", organization).color,
					lineHeight: 1.3,
				},
				{
					text: element.props?.body,
					size: card ? 15 : 14,
					weight: "normal" as const,
					color: element.style.color ?? "#747474",
					lineHeight: 1.5,
				},
			].filter((part) => part.text);
			const width = element.width - padding * 2;
			const heights = definitions.map(
				(part) =>
					Math.max(
						1,
						(part.text ?? "")
							.split("\n")
							.reduce(
								(sum, line) =>
									sum +
									Math.max(
										1,
										Math.ceil((line.length * part.size * 0.52) / width),
									),
								0,
							),
					) *
					part.size *
					part.lineHeight,
			);
			const gap = card ? 12 : 6;
			let y =
				element.y +
				(card
					? padding
					: Math.max(
							padding,
							(element.height -
								heights.reduce((a, b) => a + b, 0) -
								gap * (definitions.length - 1)) /
								2,
						));
			definitions.forEach((part, index) => {
				const height = Math.min(
					heights[index]!,
					element.y + element.height - padding - y,
				);
				if (height > 0)
					parts.push({
						...element,
						id: `${element.id}-${index}`,
						type: "text",
						x: element.x + padding,
						y,
						width,
						height,
						text: part.text,
						style: {
							fontFamily: resolved.style.fontFamily,
							fontSize: part.size,
							fontWeight: part.weight,
							color: part.color,
							lineHeight: part.lineHeight,
						},
					});
				y += heights[index]! + gap;
			});
		} else if (element.type === "arrow") {
			parts.push({ ...resolved, text: undefined });
			if (element.props?.label) {
				const { from, to } = slideArrowEndpoints(element);
				parts.push({
					...element,
					id: `${element.id}-label`,
					type: "text",
					x: (from.x + to.x) / 2 - 150,
					y: (from.y + to.y) / 2 - 24,
					width: 300,
					height: 18,
					text: element.props.label,
					style: {
						fontFamily: resolved.style.fontFamily,
						fontSize: 12,
						fontWeight: "semibold",
						textAlign: "center",
						color:
							element.props.color ??
							element.style.color ??
							slideTone("neutral", organization).color,
					},
				});
			}
		} else {
			parts.push(resolved);
		}
	}
	return parts;
}
