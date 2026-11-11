import type {
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createOutputNodeId } from "@/lib/output-models";

const ELEMENT_DEFAULTS: Record<
	OsPresentationElementType,
	Pick<OsPresentationElement, "width" | "height" | "text" | "style">
> = {
	title: {
		width: 900,
		height: 90,
		text: "Title",
		style: { fontSize: 48, fontWeight: "bold", color: "#171717" },
	},
	subtitle: {
		width: 800,
		height: 65,
		text: "Subtitle",
		style: { fontSize: 28, color: "#555555" },
	},
	text: {
		width: 540,
		height: 140,
		text: "Text",
		style: { fontSize: 24, color: "#242424" },
	},
	bullet: {
		width: 650,
		height: 250,
		text: "First point\nSecond point",
		style: { fontSize: 26, color: "#242424" },
	},
	label: {
		width: 220,
		height: 48,
		text: "LABEL",
		style: {
			fontSize: 18,
			fontWeight: "semibold",
			color: "#333333",
			background: "#f1f1f1",
			borderRadius: 12,
		},
	},
	card: {
		width: 360,
		height: 220,
		text: "Card",
		style: {
			fontSize: 24,
			color: "#242424",
			background: "#ffffff",
			borderColor: "#d1d1d1",
			borderWidth: 2,
			borderRadius: 18,
		},
	},
	box: {
		width: 300,
		height: 180,
		text: "Box",
		style: {
			fontSize: 22,
			color: "#242424",
			background: "#f3f5ff",
			borderRadius: 12,
		},
	},
	image: {
		width: 420,
		height: 260,
		text: "Image",
		style: { background: "#eeeeee", borderRadius: 12 },
	},
	svg: {
		width: 280,
		height: 200,
		text: "SVG",
		style: { background: "#eeeeee" },
	},
	divider: { width: 700, height: 8, style: { background: "#222222" } },
	shape: {
		width: 180,
		height: 180,
		style: { background: "#e5e5e5", borderRadius: 2 },
	},
	arrow: {
		width: 300,
		height: 40,
		text: "→",
		style: { fontSize: 56, color: "#222222", textAlign: "center" },
	},
	logo: {
		width: 200,
		height: 60,
		style: { fontSize: 24, fontWeight: "semibold" },
	},
};

export function createElement(
	type: OsPresentationElementType,
	index: number,
): OsPresentationElement {
	return {
		id: createOutputNodeId(type),
		type,
		x: 80 + (index % 5) * 24,
		y: 80 + (index % 5) * 24,
		...ELEMENT_DEFAULTS[type],
	};
}
