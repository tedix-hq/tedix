/**
 * The app's own small line drawings, 24 by 24, drawn here rather than taken
 * from anyone's artwork. Each coding tool and step has one, so the two
 * windows never fall back to a letter.
 */
const PATHS = {
	// Coding tools and chat apps.
	prompt: ["M5 8l4 4-4 4", "M12.5 16H19"],
	brackets: ["M9 7l-5 5 5 5", "M15 7l5 5-5 5"],
	cube: [
		"M12 3l8 4.5v9L12 21l-8-4.5v-9z",
		"M12 12l8-4.5",
		"M12 12v9",
		"M12 12L4 7.5",
	],
	braces: [
		"M9 4C7 4 6 5 6 7v2.5c0 1.4-.8 2.5-2 2.5 1.2 0 2 1.1 2 2.5V17c0 2 1 3 3 3",
		"M15 4c2 0 3 1 3 3v2.5c0 1.4.8 2.5 2 2.5-1.2 0-2 1.1-2 2.5V17c0 2-1 3-3 3",
	],
	bubble: [
		"M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7L8 20v-3.5H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
	],
	"bubble-spark": [
		"M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7L8 20v-3.5H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
		"M12 7.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z",
	],
	// Steps.
	sparkle: [
		"M11 4l1.9 5.1L18 11l-5.1 1.9L11 18l-1.9-5.1L4 11l5.1-1.9z",
		"M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
	],
	person: [
		"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
		"M4.5 20c.8-3.4 3.8-5.4 7.5-5.4s6.7 2 7.5 5.4",
	],
	terminal: [
		"M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
		"M7 10l3 2.5L7 15",
		"M12.5 15H17",
	],
	plug: ["M9 3v5", "M15 3v5", "M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z", "M12 17v4"],
	bolt: ["M13 3L5 13.5h6L10 21l8-10.5h-6z"],
	flag: ["M6 21V4", "M6 4.5h11.5l-2.2 4 2.2 4H6"],
	// Welcome lines and the two windows.
	shield: [
		"M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6z",
		"M9 12l2.2 2.2 4-4.2",
	],
	window: [
		"M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
		"M2.5 9.5h19",
		"M6 7.3h.01",
		"M8.5 7.3h.01",
	],
	laptop: ["M5.5 6h13a1 1 0 0 1 1 1v9h-15V7a1 1 0 0 1 1-1z", "M2.5 19h19"],
	clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7.5V12l3 2"],
	folder: [
		"M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	],
	// States.
	check: ["M5 12.5l4.5 4.5L19 7.5"],
	warning: [
		"M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
		"M12 9.5v4",
		"M12 17h.01",
	],
	minus: ["M7 12h10"],
	download: ["M12 4v10.5", "M7.5 10.5l4.5 4.5 4.5-4.5", "M5 19.5h14"],
	refresh: ["M20 12a8 8 0 1 1-2.6-5.9", "M20 4v4.5h-4.5"],
	arrow: ["M5 12h14", "M13 6l6 6-6 6"],
	back: ["M19 12H5", "M11 6l-6 6 6 6"],
	close: ["M6 6l12 12", "M18 6L6 18"],
	search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
} as const;

export type IconName = keyof typeof PATHS;

const SVG = "http://www.w3.org/2000/svg";

/** One drawing as an inline SVG that takes the colour of the text around it. */
export function icon(name: IconName, size = 18): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.75");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("icon", `icon-${name}`);
	for (const d of PATHS[name]) {
		const path = document.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
