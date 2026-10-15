import type {
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { PRESENTATION_HEIGHT, PRESENTATION_WIDTH } from "@/lib/output-models";

type Style = OsPresentationElement["style"];

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
	| { kind: "svg"; label: string };

export type SlideInspectorEntry = SlideInspectorField & { advanced?: boolean };

/** Families the Google Fonts loader can fetch; the stack keeps a fallback. */
export const SLIDE_FONT_FAMILIES = [
	["Inter", "Inter, sans-serif"],
	["Space Grotesk", "Space Grotesk, sans-serif"],
	["DM Sans", "DM Sans, sans-serif"],
	["IBM Plex Sans", "IBM Plex Sans, sans-serif"],
	["Manrope", "Manrope, sans-serif"],
	["Playfair Display", "Playfair Display, serif"],
	["Merriweather", "Merriweather, serif"],
	["JetBrains Mono", "JetBrains Mono, monospace"],
] as const;

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
export const SLIDE_GEOMETRY_FIELDS = advanced([
	{ kind: "number", key: "x", label: "X", min: 0, max: PRESENTATION_WIDTH },
	{ kind: "number", key: "y", label: "Y", min: 0, max: PRESENTATION_HEIGHT },
	{ kind: "number", key: "width", label: "W", min: 8, max: PRESENTATION_WIDTH },
	{
		kind: "number",
		key: "height",
		label: "H",
		min: 8,
		max: PRESENTATION_HEIGHT,
	},
]);

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
	title: textElement,
	subtitle: textElement,
	text: textElement,
	bullet: textElement,
	label: textElement,
	card: textElement,
	box: textElement,
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
	shape: [fill, radius, ...border, ...appearance],
	divider: [fill, ...appearance],
	arrow: [textColor, ...appearance],
};

export function slideInspectorFields(type: OsPresentationElementType) {
	const fields = [...SLIDE_INSPECTOR_FIELDS[type], ...SLIDE_GEOMETRY_FIELDS];
	return {
		basic: fields.filter((field) => !field.advanced),
		advanced: fields.filter((field) => field.advanced),
	};
}

const GEOMETRY_KEYS = new Set(["x", "y", "width", "height"]);

export function readSlideField(
	element: OsPresentationElement,
	key: string,
): unknown {
	if (GEOMETRY_KEYS.has(key) || key === "text")
		return element[key as "x" | "text"];
	return element.style[key as keyof Style];
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
	return element;
}
