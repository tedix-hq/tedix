import { OS_COPY } from "@/shared/os-copy";
import type {
	OsPresentationElement,
	OsPresentationElementProps,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { slideArrowEndpoints } from "@tedix/api-contract/utils/presentation-style";
import { PRESENTATION_HEIGHT, PRESENTATION_WIDTH } from "@/lib/output-models";

type Style = OsPresentationElement["style"];
type Props = OsPresentationElementProps;
/** Arrow endpoint coordinates, one key per axis. */
type ArrowPointKey = "fromX" | "fromY" | "toX" | "toY";

/**
 * The inspector's field schema, per element type, after the reference slides
 * editor: the fields an author reaches for are listed first, the rest sit
 * behind an "Advanced" disclosure. Position and size are always advanced.
 */
export type SlideInspectorField =
	| {
			kind: "number";
			key: keyof Style | "x" | "y" | "width" | "height";
			label: string;
			min?: number;
			max?: number;
			step?: number;
			placeholder?: number;
	  }
	| { kind: "color"; key: keyof Style; label: string; fallback: string }
	| {
			kind: "select";
			key: keyof Style;
			label: string;
			options: readonly string[];
			fallback: string;
	  }
	| { kind: "font"; label: string }
	| { kind: "text"; key: "text"; label: string }
	| { kind: "image-url"; label: string }
	| { kind: "svg"; label: string }
	| {
			kind: "prop-text";
			key: "eyebrow" | "title" | "body" | "label";
			label: string;
			multiline?: boolean;
	  }
	| {
			kind: "prop-number";
			key: "strokeWidth" | "radius" | ArrowPointKey;
			label: string;
			min: number;
			max: number;
			step?: number;
			placeholder?: number;
	  }
	| { kind: "prop-color"; key: "color"; label: string; fallback: string }
	| {
			kind: "prop-select";
			key: "tone" | "kind";
			label: string;
			options: readonly string[];
			fallback: string;
	  }
	| { kind: "prop-toggle"; key: "dashed" | "compact"; label: string }
	/** Comma-separated words drawn in the accent tone. */
	| { kind: "highlight"; label: string }
	/** Bullet list items, one per line, stored as the element's text. */
	| { kind: "items"; label: string };

type SlideInspectorEntry = SlideInspectorField & { advanced?: boolean };

/** Families the Google Fonts loader can fetch; the stack keeps a fallback. */
export const SLIDE_FONT_FAMILIES = OS_COPY.slideFontFamilies;

const fontSize: SlideInspectorEntry = {
	kind: "number",
	key: "fontSize",
	label: "Font size",
	min: 8,
	max: 180,
	step: 1,
	placeholder: 24,
};
const fontWeight: SlideInspectorEntry = {
	kind: "select",
	key: "fontWeight",
	label: "Font weight",
	options: ["light", "normal", "medium", "semibold", "bold"],
	fallback: "normal",
};
const textAlign: SlideInspectorEntry = {
	kind: "select",
	key: "textAlign",
	label: "Text align",
	options: ["left", "center", "right"],
	fallback: "left",
};
const textColor: SlideInspectorEntry = {
	kind: "color",
	key: "color",
	label: "Text color",
	fallback: "#222222",
};
const fill: SlideInspectorEntry = {
	kind: "color",
	key: "background",
	label: "Fill color",
	fallback: "#ffffff",
};
const radius: SlideInspectorEntry = {
	kind: "number",
	key: "borderRadius",
	label: "Corner radius",
	min: 0,
	max: 200,
	step: 1,
	placeholder: 0,
};
const fit: SlideInspectorEntry = {
	kind: "select",
	key: "fit",
	label: "Fit",
	options: ["contain", "cover"],
	fallback: "contain",
};
const alt: SlideInspectorEntry = {
	kind: "text",
	key: "text",
	label: "Alt text",
};

const advanced = (fields: SlideInspectorField[]): SlideInspectorEntry[] =>
	fields.map((field) => ({ ...field, advanced: true }));

const typography = advanced([
	{
		kind: "number",
		key: "lineHeight",
		label: "Line height",
		min: 0.5,
		max: 4,
		step: 0.05,
	},
	{
		kind: "number",
		key: "letterSpacing",
		label: "Letter spacing (px)",
		min: -20,
		max: 40,
		step: 0.1,
	},
	{
		kind: "number",
		key: "padding",
		label: "Padding",
		min: 0,
		max: 200,
		step: 1,
		placeholder: 0,
	},
	{
		kind: "select",
		key: "verticalAlign",
		label: "Vertical align",
		options: ["top", "middle", "bottom"],
		fallback: "top",
	},
]);
const border = advanced([
	{
		kind: "color",
		key: "borderColor",
		label: "Border color",
		fallback: "#222222",
	},
	{
		kind: "number",
		key: "borderWidth",
		label: "Border width",
		min: 0,
		max: 24,
		step: 1,
		placeholder: 0,
	},
	{
		kind: "select",
		key: "borderStyle",
		label: "Border style",
		options: ["solid", "dashed", "dotted"],
		fallback: "solid",
	},
]);
const appearance = advanced([
	{
		kind: "number",
		key: "opacity",
		label: "Opacity",
		min: 0,
		max: 1,
		step: 0.05,
		placeholder: 1,
	},
	{
		kind: "number",
		key: "rotation",
		label: "Rotation (deg)",
		min: -360,
		max: 360,
		step: 1,
		placeholder: 0,
	},
]);
const SLIDE_GEOMETRY_FIELDS = advanced([
	{ kind: "number", key: "x", label: "X", min: 0, max: PRESENTATION_WIDTH },
	{ kind: "number", key: "y", label: "Y", min: 0, max: PRESENTATION_HEIGHT },
	{ kind: "number", key: "width", label: "W", min: 1, max: PRESENTATION_WIDTH },
	{
		kind: "number",
		key: "height",
		label: "H",
		min: 1,
		max: PRESENTATION_HEIGHT,
	},
]);

/** Clears the prop, so the renderer's own default applies. */
const DEFAULT_PROP_OPTION = "default";
const tone: SlideInspectorEntry = {
	kind: "prop-select",
	key: "tone",
	label: "Tone",
	options: [
		DEFAULT_PROP_OPTION,
		"neutral",
		"accent",
		"success",
		"warning",
		"danger",
		"info",
	],
	fallback: DEFAULT_PROP_OPTION,
};
const highlight: SlideInspectorEntry = {
	kind: "highlight",
	label: "Highlight words",
};
const parts: SlideInspectorEntry[] = [
	{ kind: "prop-text", key: "eyebrow", label: "Eyebrow" },
	{ kind: "prop-text", key: "title", label: "Title" },
	{ kind: "prop-text", key: "body", label: "Body", multiline: true },
];
const point = (
	key: ArrowPointKey,
	label: string,
	max: number,
): SlideInspectorEntry => ({ kind: "prop-number", key, label, min: 0, max });

const textElement: SlideInspectorEntry[] = [
	{ kind: "font", label: "Font" },
	fontSize,
	fontWeight,
	textAlign,
	textColor,
	fill,
	radius,
	...typography,
	...border,
	...appearance,
];

const SLIDE_INSPECTOR_FIELDS: Record<
	OsPresentationElementType,
	SlideInspectorEntry[]
> = {
	title: [highlight, ...textElement],
	subtitle: [highlight, ...textElement],
	text: [highlight, ...textElement],
	bullet: [
		{ kind: "items", label: "Items" },
		highlight,
		{ kind: "prop-toggle", key: "compact", label: "Compact" },
		...textElement,
	],
	label: [tone, highlight, ...textElement],
	card: [...parts, tone, highlight, ...textElement],
	box: [...parts, tone, highlight, ...textElement],
	image: [
		{ kind: "image-url", label: "Image URL" },
		alt,
		fit,
		radius,
		{ ...fill, advanced: true },
		...border,
		...appearance,
	],
	svg: [
		{ kind: "svg", label: "SVG code" },
		alt,
		fit,
		{ ...fill, advanced: true },
		{ ...radius, advanced: true },
		...appearance,
	],
	shape: [
		{
			kind: "prop-select",
			key: "kind",
			label: "Shape",
			options: ["rectangle", "ellipse"],
			fallback: "rectangle",
		},
		fill,
		{
			kind: "prop-number",
			key: "radius",
			label: "Corner radius",
			min: 0,
			max: 600,
			step: 1,
			placeholder: 0,
		},
		...border,
		...appearance,
	],
	divider: [fill, ...appearance],
	arrow: [
		point("fromX", "From X", PRESENTATION_WIDTH),
		point("fromY", "From Y", PRESENTATION_HEIGHT),
		point("toX", "To X", PRESENTATION_WIDTH),
		point("toY", "To Y", PRESENTATION_HEIGHT),
		{ kind: "prop-text", key: "label", label: "Label" },
		{ kind: "prop-toggle", key: "dashed", label: "Dashed" },
		{
			kind: "prop-number",
			key: "strokeWidth",
			label: "Line width",
			min: 0.5,
			max: 24,
			step: 0.5,
			placeholder: 2,
		},
		{
			kind: "prop-color",
			key: "color",
			label: "Line color",
			fallback: "#222222",
		},
		...appearance,
	],
	logo: [...appearance],
};

export function slideInspectorFields(type: OsPresentationElementType) {
	const fields = [...SLIDE_INSPECTOR_FIELDS[type], ...SLIDE_GEOMETRY_FIELDS];
	return {
		basic: fields.filter((field) => !field.advanced),
		advanced: fields.filter((field) => field.advanced),
	};
}

const GEOMETRY_KEYS = new Set(["x", "y", "width", "height"]);

function readSlideField(element: OsPresentationElement, key: string): unknown {
	if (GEOMETRY_KEYS.has(key) || key === "text")
		return element[key as "x" | "text"];
	return element.style[key as keyof Style];
}

const ARROW_POINTS: Record<ArrowPointKey, ["from" | "to", "x" | "y"]> = {
	fromX: ["from", "x"],
	fromY: ["from", "y"],
	toX: ["to", "x"],
	toY: ["to", "y"],
};

/**
 * The value a field shows, as the renderer draws it: arrow endpoints show
 * their drawn position before they are stored, a shape's radius falls back
 * to its style radius, and a card's title falls back to its text.
 */
export function slideFieldValue(
	element: OsPresentationElement,
	field: SlideInspectorField,
): string | number | boolean | undefined {
	const props: Props = element.props ?? {};
	switch (field.kind) {
		case "number":
		case "color":
		case "select":
			return readSlideField(element, field.key) as string | number | undefined;
		case "font":
			return element.style.fontFamily;
		case "text":
		case "items":
			return element.text;
		case "prop-text":
			return field.key === "title"
				? (props.title ?? element.text)
				: props[field.key];
		case "prop-number": {
			if (field.key === "radius")
				return props.radius ?? element.style.borderRadius;
			if (field.key === "strokeWidth") return props.strokeWidth;
			const [end, axis] = ARROW_POINTS[field.key];
			return slideArrowEndpoints(element)[end][axis];
		}
		case "prop-color":
			return props.color ?? element.style.color;
		case "prop-select":
			return props[field.key];
		case "prop-toggle":
			return props[field.key] ?? false;
		case "highlight":
			return props.highlight?.join(", ");
		default:
			return undefined;
	}
}

/**
 * Writes the image focal point, or clears it to recenter. The point is a 0-1
 * fraction of the source the frame keeps in view; undefined is centered.
 */
export function writeSlideFocalPoint(
	element: OsPresentationElement,
	focalPoint: { x: number; y: number } | undefined,
): OsPresentationElement {
	return withProps(element, {
		focalPoint: focalPoint && {
			x: Math.min(1, Math.max(0, focalPoint.x)),
			y: Math.min(1, Math.max(0, focalPoint.y)),
		},
	});
}

/** Merges props and drops cleared keys, so an element never stores `{}`. */
function withProps(
	element: OsPresentationElement,
	patch: Partial<Props>,
): OsPresentationElement {
	const props = Object.fromEntries(
		Object.entries({ ...element.props, ...patch }).filter(
			([, value]) => value !== undefined,
		),
	) as Props;
	return { ...element, props: Object.keys(props).length ? props : undefined };
}

/** Comma-separated words, trimmed and deduplicated, within the schema caps. */
export function parseHighlightWords(raw: string): string[] | undefined {
	const words = [
		...new Set(
			raw
				.split(",")
				.map((word) => word.trim().slice(0, 300))
				.filter(Boolean),
		),
	].slice(0, 100);
	return words.length ? words : undefined;
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

function writeSlideProp(
	element: OsPresentationElement,
	field: SlideInspectorField,
	raw: string,
): OsPresentationElement {
	switch (field.kind) {
		case "items":
			return { ...element, text: raw || undefined };
		case "prop-text":
			return withProps(element, { [field.key]: raw || undefined });
		case "prop-color":
			return withProps(element, { color: raw || undefined });
		case "prop-select":
			return withProps(element, {
				[field.key]:
					raw === "" || raw === DEFAULT_PROP_OPTION ? undefined : raw,
			});
		case "prop-toggle":
			return withProps(element, { [field.key]: raw === "true" || undefined });
		case "highlight":
			return withProps(element, { highlight: parseHighlightWords(raw) });
		case "prop-number": {
			const number = Number(raw);
			const valid = raw !== "" && Number.isFinite(number);
			if (field.key === "radius" || field.key === "strokeWidth")
				return withProps(element, {
					[field.key]: valid ? clamp(number, field.min, field.max) : undefined,
				});
			if (!valid) return element;
			// Both ends are stored together, so editing one coordinate never
			// leaves the other end following the element's box.
			const [end, axis] = ARROW_POINTS[field.key];
			const endpoints = slideArrowEndpoints(element);
			return withProps(element, {
				...endpoints,
				[end]: {
					...endpoints[end],
					[axis]: Math.round(clamp(number, field.min, field.max)),
				},
			});
		}
		default:
			return element;
	}
}

/**
 * Writes one field. Numbers are clamped to the schema's bounds, so a typed
 * value can never make the deck invalid; geometry also stays on the canvas.
 * An empty value clears a style override back to its default.
 */
export function writeSlideField(
	element: OsPresentationElement,
	field: SlideInspectorField,
	raw: string,
): OsPresentationElement {
	if (field.kind === "number") {
		if (raw === "" || !Number.isFinite(Number(raw))) {
			if (GEOMETRY_KEYS.has(field.key)) return element;
			return {
				...element,
				style: { ...element.style, [field.key]: undefined },
			};
		}
		let value = Number(raw);
		if (field.min !== undefined) value = Math.max(field.min, value);
		if (field.max !== undefined) value = Math.min(field.max, value);
		if (GEOMETRY_KEYS.has(field.key)) {
			const next = { ...element, [field.key]: Math.round(value) };
			next.width = Math.min(next.width, PRESENTATION_WIDTH);
			next.height = Math.min(next.height, PRESENTATION_HEIGHT);
			next.x = Math.min(next.x, PRESENTATION_WIDTH - next.width);
			next.y = Math.min(next.y, PRESENTATION_HEIGHT - next.height);
			return next;
		}
		return { ...element, style: { ...element.style, [field.key]: value } };
	}
	if (field.kind === "text") return { ...element, text: raw || undefined };
	if (field.kind === "color" || field.kind === "select")
		return {
			...element,
			style: { ...element.style, [field.key]: raw || undefined },
		};
	if (field.kind === "font")
		return {
			...element,
			style: { ...element.style, fontFamily: raw || undefined },
		};
	return writeSlideProp(element, field, raw);
}
