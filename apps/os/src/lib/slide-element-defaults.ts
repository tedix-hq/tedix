import type {
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createOutputNodeId } from "@/lib/output-models";

/** Each further element of the same type lands this much lower and to the right. */
const STAGGER = 16;

type ElementDefault = Pick<
	OsPresentationElement,
	"x" | "y" | "width" | "height" | "text" | "style" | "props"
>;

const ELEMENT_DEFAULTS: Record<OsPresentationElementType, ElementDefault> = {
	title: {
		props: { autoHeight: true },
		x: 33,
		y: 197,
		width: 760,
		height: 140,
		text: "Title",
		style: {
			fontSize: 58,
			fontWeight: "bold",
			color: "#171717",
			lineHeight: 1.1,
			letterSpacing: -1.7,
		},
	},
	subtitle: {
		props: { autoHeight: true },
		x: 33,
		y: 350,
		width: 760,
		height: 40,
		text: "Subtitle",
		style: { fontSize: 17, fontWeight: "semibold", color: "#555555" },
	},
	text: {
		props: { autoHeight: true },
		x: 100,
		y: 200,
		width: 400,
		height: 120,
		text: "Text",
		style: { fontSize: 19, color: "#000000", lineHeight: 1.6 },
	},
	bullet: {
		props: { autoHeight: true },
		x: 100,
		y: 200,
		width: 850,
		height: 220,
		text: "First point\nSecond point",
		style: { fontSize: 19, color: "#000000", lineHeight: 1.6 },
	},
	label: {
		x: 36,
		y: 35,
		width: 220,
		height: 40,
		text: "LABEL",
		style: {
			fontSize: 14,
			fontWeight: "semibold",
			color: "#333333",
			background: "#f1f1f1",
			borderRadius: 12,
		},
	},
	sectionLabel: {
		props: { autoHeight: true },
		x: 36,
		y: 35,
		width: 240,
		height: 24,
		text: "SECTION",
		style: {},
	},
	tonePill: {
		x: 100,
		y: 200,
		width: 160,
		height: 34,
		text: "Pill",
		props: { tone: "accent" },
		style: { fontSize: 14, textAlign: "center" },
	},
	card: {
		x: 100,
		y: 240,
		width: 280,
		height: 260,
		text: "Card",
		style: {
			fontSize: 19,
			color: "#242424",
			background: "#ffffff",
			borderColor: "#d1d1d1",
			borderWidth: 1,
			borderRadius: 12,
		},
	},
	box: {
		x: 100,
		y: 240,
		width: 220,
		height: 110,
		text: "Box",
		style: {
			fontSize: 17,
			color: "#242424",
			background: "#f3f5ff",
			borderRadius: 12,
		},
	},
	image: {
		x: 600,
		y: 0,
		width: 600,
		height: 675,
		text: "Image",
		style: { background: "#eeeeee", fit: "cover" },
	},
	svg: {
		x: 100,
		y: 200,
		width: 280,
		height: 200,
		text: "SVG",
		style: { background: "#eeeeee" },
	},
	divider: {
		x: 100,
		y: 400,
		width: 400,
		height: 2,
		style: { background: "#d4d4d4" },
	},
	shape: {
		x: 100,
		y: 200,
		width: 200,
		height: 200,
		style: { background: "#e5e5e5", borderRadius: 2 },
	},
	arrow: {
		x: 184,
		y: 372,
		width: 432,
		height: 56,
		props: { from: { x: 200, y: 400 }, to: { x: 600, y: 400 }, strokeWidth: 2 },
		style: { color: "#737373" },
	},
	logo: {
		x: 1000,
		y: 30,
		width: 160,
		height: 48,
		style: { fontSize: 24, fontWeight: "bold" },
	},
};

/**
 * A new element of `type` with its type's defaults, moved along by `sameType`
 * steps so a second one does not land exactly on the first.
 */
export function createElement(
	type: OsPresentationElementType,
	sameType: number,
): OsPresentationElement {
	const { x, y, ...rest } = structuredClone(ELEMENT_DEFAULTS[type]);
	const step = Math.max(
		0,
		Math.min(
			(sameType % 10) * STAGGER,
			1_200 - rest.width - x,
			675 - rest.height - y,
		),
	);
	const shift = (point?: { x: number; y: number }) =>
		point && { x: point.x + step, y: point.y + step };
	if (rest.props?.from) rest.props.from = shift(rest.props.from);
	if (rest.props?.to) rest.props.to = shift(rest.props.to);
	return {
		id: createOutputNodeId(type),
		type,
		x: x + step,
		y: y + step,
		...rest,
	};
}
