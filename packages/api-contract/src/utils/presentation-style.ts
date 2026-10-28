import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
	OsPresentationTheme,
} from "../schemas/os-workspaces";
import {
	DEFAULT_ORGANIZATION_OS_THEME,
	type OrganizationOsTheme,
} from "../schemas/os-theme";

export interface PresentationAppearance {
	name?: string;
	logoUrl?: string | null;
	appearance?: OrganizationOsTheme | null;
}

export function slideTone(
	tone: NonNullable<OsPresentationElement["props"]>["tone"] = "neutral",
	organization: PresentationAppearance = {},
) {
	const theme = organization.appearance ?? DEFAULT_ORGANIZATION_OS_THEME;
	const color =
		theme.slideTones?.[tone] ??
		{
			neutral: theme.light.foreground,
			accent: theme.light.accent,
			success: "#15803d",
			warning: "#a16207",
			danger: "#b91c1c",
			info: "#0369a1",
		}[tone];
	return { color, fill: `${color}14`, border: `${color}40` };
}

export function slideArrowEndpoints(element: OsPresentationElement) {
	return {
		from: element.props?.from ?? {
			x: element.x + 2,
			y: element.y + element.height / 2,
		},
		to: element.props?.to ?? {
			x: element.x + element.width - 2,
			y: element.y + element.height / 2,
		},
	};
}

export function slideElementBox(element: OsPresentationElement) {
	if (element.type !== "arrow" || (!element.props?.from && !element.props?.to))
		return element;
	const { from, to } = slideArrowEndpoints(element);
	const x = Math.max(0, Math.min(from.x, to.x) - 16);
	const y = Math.max(0, Math.min(from.y, to.y) - 28);
	return {
		...element,
		x,
		y,
		width: Math.max(32, Math.max(from.x, to.x) - x + 16),
		height: Math.max(56, Math.max(from.y, to.y) - y + 28),
	};
}

export function presentationCanvasLength(value: number): string {
	return `calc(${value} * 100cqw / 1200)`;
}

/**
 * The font stack an element renders with: its own override first, then the
 * deck theme — `headingFont` for title and subtitle elements, `bodyFont` for
 * every other text-bearing element.
 */
export function slideThemeFontFamily(
	element: Pick<OsPresentationElement, "type" | "style">,
	theme: OsPresentationTheme | undefined,
): string | undefined {
	return (
		element.style?.fontFamily ??
		(element.type === "title" || element.type === "subtitle"
			? theme?.headingFont
			: theme?.bodyFont)
	);
}

/** Shared by slide editors, viewers and fixed-size PDF/PNG exports. */
export function slideElementStyle(
	element: OsPresentationElement,
	sizing: "canvas" | "pixels" = "canvas",
	organization: PresentationAppearance = {},
	theme?: OsPresentationTheme,
) {
	const { style } = element;
	const box = slideElementBox(element);
	const container = element.type === "card" || element.type === "box";
	const pill = element.type === "label" && element.props?.tone !== undefined;
	const tone = slideTone(element.props?.tone, organization);
	const fontSize = style.fontSize ?? 24;
	const length =
		sizing === "pixels"
			? (value: number) => `${value}px`
			: presentationCanvasLength;
	return {
		left: sizing === "pixels" ? length(box.x) : `${(box.x / 1200) * 100}%`,
		top: sizing === "pixels" ? length(box.y) : `${(box.y / 675) * 100}%`,
		width:
			sizing === "pixels" ? length(box.width) : `${(box.width / 1200) * 100}%`,
		height:
			sizing === "pixels" ? length(box.height) : `${(box.height / 675) * 100}%`,
		fontFamily: slideThemeFontFamily(element, theme) ?? "Arial, sans-serif",
		fontSize: length(fontSize),
		lineHeight: style.lineHeight ?? (fontSize >= 40 ? 1.1 : 1.3),
		fontWeight:
			style.fontWeight === "semibold"
				? 600
				: style.fontWeight === "medium"
					? 500
					: style.fontWeight === "light"
						? 300
						: (style.fontWeight ?? "normal"),
		letterSpacing:
			style.letterSpacing === undefined
				? "normal"
				: length(style.letterSpacing),
		display: style.verticalAlign ? "flex" : undefined,
		flexDirection: style.verticalAlign ? ("column" as const) : undefined,
		justifyContent:
			style.verticalAlign === "middle"
				? "center"
				: style.verticalAlign === "bottom"
					? "flex-end"
					: style.verticalAlign
						? "flex-start"
						: undefined,
		color: style.color ?? (pill ? tone.color : undefined),
		background: style.background ?? (container || pill ? tone.fill : undefined),
		borderColor: style.borderColor ?? (container ? tone.border : undefined),
		borderStyle:
			style.borderWidth || container
				? element.props?.dashed
					? "dashed"
					: (style.borderStyle ?? "solid")
				: undefined,
		borderWidth:
			style.borderWidth !== undefined || container
				? length(style.borderWidth ?? 1)
				: undefined,
		borderRadius:
			element.type === "shape" && element.props?.kind === "ellipse"
				? "50%"
				: length(
						element.props?.radius ??
							style.borderRadius ??
							(pill ? 600 : container ? 2 : 0),
					),
		textAlign: style.textAlign,
		opacity: style.opacity,
		transform: style.rotation ? `rotate(${style.rotation}deg)` : undefined,
		padding:
			style.padding !== undefined
				? length(style.padding)
				: container
					? length(element.type === "card" ? 20 : 14)
					: pill
						? `${length(5)} ${length(12)}`
						: 0,
		boxSizing: "border-box" as const,
	};
}

export function parseSlideText(
	text: string,
	highlight: string[] = [],
): { text: string; bold: boolean; highlight?: boolean }[] {
	const parts = text
		.split(/(\*\*[^*]+\*\*)/g)
		.filter(Boolean)
		.map((part) => {
			const bold = /^\*\*[^*]+\*\*$/.test(part);
			return { text: bold ? part.slice(2, -2) : part, bold };
		});
	const words = highlight.filter(Boolean).sort((a, b) => b.length - a.length);
	if (!words.length) return parts;
	const expression = new RegExp(
		`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
		"g",
	);
	return parts.flatMap((part) =>
		part.text
			.split(expression)
			.filter(Boolean)
			.map((text) => ({
				text,
				bold: part.bold,
				...(words.includes(text) ? { highlight: true } : {}),
			})),
	);
}

/** Arrow geometry in the element's own canvas units; rotation belongs to its box. */
export function slideArrowPath(element: OsPresentationElement): string {
	if (element.props?.from || element.props?.to) {
		const box = slideElementBox(element);
		const { from, to } = slideArrowEndpoints(element);
		const angle = Math.atan2(to.y - from.y, to.x - from.x);
		const head = Math.min(12, Math.hypot(to.x - from.x, to.y - from.y) / 3);
		const x = to.x - box.x,
			y = to.y - box.y;
		return `M ${from.x - box.x} ${from.y - box.y} L ${x} ${y} M ${x - head * Math.cos(angle - Math.PI / 6)} ${y - head * Math.sin(angle - Math.PI / 6)} L ${x} ${y} L ${x - head * Math.cos(angle + Math.PI / 6)} ${y - head * Math.sin(angle + Math.PI / 6)}`;
	}
	const { width, height } = element;
	const inset = 2;
	const middle = height / 2;
	const head = Math.min(height / 2 - inset, width / 4);
	const tip = width - inset;
	return `M ${inset} ${middle} H ${tip} M ${tip - head} ${middle - head} L ${tip} ${middle} L ${tip - head} ${middle + head}`;
}

export function escapeSlideHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			]!,
	);
}

/** Reject declaration injection and CSS network loads before serializing HTML. */
export function slideCss(
	style: Record<string, string | number | undefined>,
): string {
	return Object.entries(style)
		.flatMap(([key, value]) => {
			if (value === undefined) return [];
			const text = String(value);
			if (
				!/^[a-zA-Z0-9 #.,%()'"*+\-/]*$/.test(text) ||
				Array.from(text.matchAll(/([a-z-]+)\s*\(/gi)).some(
					(match) =>
						!/^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix|calc|rotate)$/i.test(
							match[1]!,
						),
				)
			)
				return [];
			return [
				`${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${escapeSlideHtml(text)}`,
			];
		})
		.join(";");
}

export function slideImageSource(
	source: string | null | undefined,
): string | undefined {
	return source &&
		/^(https:\/\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i.test(source)
		? source
		: undefined;
}

/** The element's `object-position` value, or undefined when the image is centered. */
export function slideFocalPosition(
	element: OsPresentationElement,
): string | undefined {
	const focal = element.props?.focalPoint;
	if (!focal) return undefined;
	const percent = (value: number) =>
		String(Math.round(Math.max(0, Math.min(1, value)) * 10000) / 100);
	return `${percent(focal.x)}% ${percent(focal.y)}%`;
}

export function slideTextMarkup(
	text: string,
	element: OsPresentationElement,
	organization: PresentationAppearance = {},
): string {
	const accent = slideTone("accent", organization).color;
	return parseSlideText(text, element.props?.highlight)
		.map((part) => {
			let body = escapeSlideHtml(part.text);
			if (part.bold) body = `<strong style="font-weight:700">${body}</strong>`;
			if (part.highlight)
				body = `<span style="${slideCss({ color: accent })}">${body}</span>`;
			return body;
		})
		.join("");
}

/** Escaped content markup is shared verbatim by OS and PDF/PNG exports. */
export function slideElementMarkup(
	element: OsPresentationElement,
	sizing: "canvas" | "pixels" = "canvas",
	organization: PresentationAppearance = {},
): string {
	const length =
		sizing === "pixels"
			? (value: number) => `${value}px`
			: presentationCanvasLength;
	const props = element.props;
	const text = (value: string) => slideTextMarkup(value, element, organization);
	const focal = slideFocalPosition(element);
	const image = (source: string, alt: string) =>
		`<img src="${escapeSlideHtml(source)}" alt="${escapeSlideHtml(alt)}" draggable="false" class="h-full w-full object-${element.style.fit === "cover" ? "cover" : "contain"}" style="width:100%;height:100%;object-fit:${element.style.fit === "cover" ? "cover" : "contain"}${focal ? `;object-position:${escapeSlideHtml(focal)}` : ""}">`;
	if (element.type === "logo") {
		const source = slideImageSource(organization.logoUrl);
		return source
			? image(source, organization.name ?? "Organization logo")
			: text(organization.name ?? "");
	}
	if (element.type === "image" || element.type === "svg") {
		const source = slideImageSource(element.src);
		return source ? image(source, element.text ?? "Slide visual") : "";
	}
	if (element.type === "shape" || element.type === "divider") return "";
	if (element.type === "arrow") {
		const box = slideElementBox(element);
		const color =
			props?.color ??
			element.style.color ??
			slideTone("neutral", organization).color;
		const endpoints = slideArrowEndpoints(element);
		const label = props?.label ?? "";
		return `<svg width="100%" height="100%" viewBox="0 0 ${escapeSlideHtml(String(box.width))} ${escapeSlideHtml(String(box.height))}" style="pointer-events:none;overflow:visible"><path d="${escapeSlideHtml(slideArrowPath(element))}" fill="none" stroke="${escapeSlideHtml(color)}" stroke-width="${escapeSlideHtml(String(props?.strokeWidth ?? element.style.borderWidth ?? 2))}"${props?.dashed ? ' stroke-dasharray="6 6"' : ""}/>${label ? `<text x="${escapeSlideHtml(String((endpoints.from.x + endpoints.to.x) / 2 - box.x))}" y="${escapeSlideHtml(String((endpoints.from.y + endpoints.to.y) / 2 - box.y - 8))}" text-anchor="middle" fill="${escapeSlideHtml(color)}" font-size="12" font-weight="600">${escapeSlideHtml(label)}</text>` : ""}</svg>`;
	}
	if (element.type === "card" || element.type === "box") {
		const card = element.type === "card";
		const part = (
			name: string,
			value: string | undefined,
			style: Record<string, string | number | undefined>,
		) =>
			value
				? `<div data-slide-part="${name}" style="${slideCss(style)}">${text(value)}</div>`
				: "";
		return `<div style="display:flex;flex-direction:column;gap:${length(card ? 12 : 6)};height:100%;${card ? "" : "justify-content:center"}">${part("eyebrow", props?.eyebrow, { fontSize: length(10), fontWeight: 600, lineHeight: 1.2, color: slideTone("accent", organization).color, textTransform: "uppercase", letterSpacing: length(0.5) })}${part("title", props?.title ?? element.text, { fontSize: length(card ? 18 : 16), fontWeight: 600, lineHeight: 1.3, color: element.style.color ?? slideTone("neutral", organization).color })}${part("body", props?.body, { fontSize: length(card ? 15 : 14), fontWeight: 400, lineHeight: 1.5, color: element.style.color ?? "#747474", whiteSpace: "pre-wrap" })}</div>`;
	}
	if (element.type === "bullet") {
		const compact = props?.compact;
		const color = slideTone("accent", organization).color;
		return `<div role="list" style="display:flex;flex-direction:column;gap:${length(compact ? 8 : 10)}">${(
			element.text ?? ""
		)
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean)
			.map(
				(item) =>
					`<div role="listitem" style="display:flex;align-items:flex-start;gap:${length(12)}"><span aria-hidden="true" style="${slideCss({ width: length(6), height: length(6), flex: `0 0 ${length(6)}`, marginTop: length((element.style.fontSize ?? (compact ? 17 : 19)) * 0.4), borderRadius: "50%", background: color })}"></span><div style="${slideCss({ flex: "1", minWidth: "0", fontSize: length(element.style.fontSize ?? (compact ? 17 : 19)), lineHeight: element.style.lineHeight ?? (compact ? 1.45 : 1.5) })}">${text(item)}</div></div>`,
			)
			.join("")}</div>`;
	}
	return text(element.text ?? "");
}

export function slideBackgroundMarkup(
	slide: OsPresentationCanvasSlide,
	sizing: "canvas" | "pixels" = "canvas",
	organization: PresentationAppearance = {},
): string {
	const length =
		sizing === "pixels"
			? (value: number) => `${value}px`
			: presentationCanvasLength;
	const source = slideImageSource(slide.backgroundImage);
	let markup = source
		? `<img alt="" src="${escapeSlideHtml(source)}" draggable="false" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none">`
		: "";
	if (slide.dotGridOpacity)
		markup += `<div data-slide-background="dots" style="${slideCss({ position: "absolute", inset: "0", pointerEvents: "none", opacity: slide.dotGridOpacity, backgroundImage: `radial-gradient(${slideTone("neutral", organization).color} 1px, transparent 1px)`, backgroundSize: `${length(20)} ${length(20)}` })}"></div>`;
	if (slide.insetSurface)
		markup += `<div data-slide-background="inset" style="${slideCss({ position: "absolute", pointerEvents: "none", inset: length(slide.insetSurface.inset), background: slide.insetSurface.color, borderRadius: length(slide.insetSurface.radius) })}"></div>`;
	return markup;
}

/** Move or resize explicit arrow endpoints with the element's ordinary box. */
export function slideElementGeometry(
	element: OsPresentationElement,
	next: OsPresentationElement,
): OsPresentationElement {
	if (
		element.type !== "arrow" ||
		(!element.props?.from && !element.props?.to) ||
		next.props !== element.props
	)
		return next;
	const { from, to } = slideArrowEndpoints(element);
	const point = ({ x, y }: { x: number; y: number }) => ({
		x: Math.max(
			0,
			Math.min(1200, next.x + ((x - element.x) * next.width) / element.width),
		),
		y: Math.max(
			0,
			Math.min(675, next.y + ((y - element.y) * next.height) / element.height),
		),
	});
	return {
		...next,
		props: { ...next.props, from: point(from), to: point(to) },
	};
}
