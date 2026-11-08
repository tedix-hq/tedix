import { z } from "zod";
import {
	OsOutputContentSchema,
	OsPresentationPatchOpSchema,
	OsPresentationSlideOutlineSchema,
	type OsOutputContent,
	type OsPresentationCanvasSlide,
	type OsPresentationDeck,
	type OsPresentationElement,
	type OsPresentationSlide,
} from "../schemas/os-workspaces";

type Presentation = Extract<OsOutputContent, { kind: "presentation" }>;
type Outline = z.infer<typeof OsPresentationSlideOutlineSchema>;

function canvasSlide(outline: Outline): OsPresentationCanvasSlide {
	const elements: OsPresentationElement[] = [
		{
			id: `title-${crypto.randomUUID()}`,
			type: "title",
			x: 72,
			y: 72,
			width: 1_056,
			height: 96,
			text: outline.title,
			style: { fontSize: 44, fontWeight: "semibold" },
		},
	];
	if (outline.bullets.length)
		elements.push({
			id: `bullet-${crypto.randomUUID()}`,
			type: "bullet",
			x: 72,
			y: 200,
			width: 1_056,
			height: 380,
			text: outline.bullets.join("\n"),
			style: { fontSize: 24 },
		});
	return {
		id: `slide-${crypto.randomUUID()}`,
		name: outline.title.slice(0, 200),
		layout: outline.bullets.length ? "title-content" : "title",
		background: "#ffffff",
		elements,
		...outline.canvas,
		...(outline.notes ? { notes: outline.notes } : {}),
	};
}

function replaceOutline(
	slide: OsPresentationCanvasSlide,
	outline: Outline,
): OsPresentationCanvasSlide {
	const ordered = [...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x);
	const title = ordered.find((element) => element.type === "title");
	const bullets = ordered.filter((element) => element.type === "bullet");
	const replacements = new Map<string, string>();
	if (title) replacements.set(title.id, outline.title);
	let offset = 0;
	for (const [index, element] of bullets.entries()) {
		const length =
			index === bullets.length - 1
				? outline.bullets.length - offset
				: (element.text ?? "").split("\n").filter(Boolean).length;
		replacements.set(
			element.id,
			outline.bullets.slice(offset, offset + Math.max(0, length)).join("\n"),
		);
		offset += Math.max(0, length);
	}
	const defaults = canvasSlide(outline).elements;
	const elements = slide.elements.map((element) =>
		replacements.has(element.id)
			? { ...element, text: replacements.get(element.id) }
			: element,
	);
	if (!title) elements.push(defaults[0]!);
	if (!bullets.length && outline.bullets.length) elements.push(defaults[1]!);
	return {
		...slide,
		name: outline.title.slice(0, 200),
		elements,
		...outline.canvas,
		...(outline.notes ? { notes: outline.notes } : { notes: undefined }),
	};
}

export function projectPresentationDeck(
	deck: OsPresentationDeck,
): OsPresentationSlide[] {
	return deck.slides.map((slide) => {
		const ordered = [...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x);
		return {
			title: (
				ordered.find((element) => element.type === "title")?.text ?? slide.name
			).slice(0, 300),
			bullets: ordered
				.filter((element) => element.type === "bullet")
				.flatMap((element) => (element.text ?? "").split("\n"))
				.map((text) => text.trim())
				.filter(Boolean)
				.slice(0, 30),
			...(slide.notes ? { notes: slide.notes } : {}),
		};
	});
}

/** Patch the primary canvas, then derive its outline without discarding visuals. */
export function applyPresentationPatch(
	content: Presentation,
	operations: unknown,
): Presentation {
	const ops = z
		.array(OsPresentationPatchOpSchema)
		.min(1)
		.max(100)
		.parse(operations);
	const initial = content.slides.map((slide) => canvasSlide(slide));
	const deck: OsPresentationDeck = content.deck ?? {
		width: 1_200,
		height: 675,
		activeSlideId: initial[0]?.id ?? `slide-${crypto.randomUUID()}`,
		slides: initial,
	};
	const slides = [...deck.slides];
	for (const [position, op] of ops.entries()) {
		const index = op.op === "move" ? op.from : op.index;
		const limit = op.op === "insert" ? slides.length : slides.length - 1;
		if (index > limit || (op.op === "move" && op.to >= slides.length))
			throw new Error(
				`ops[${position}]: ${op.op} index ${index} is out of range (the deck holds ${slides.length} slides at that step)`,
			);
		if (op.op === "insert") slides.splice(op.index, 0, canvasSlide(op.slide));
		else if (op.op === "replace")
			slides[op.index] = replaceOutline(slides[op.index]!, op.slide);
		else if (op.op === "delete") slides.splice(op.index, 1);
		else slides.splice(op.to, 0, slides.splice(op.from, 1)[0]!);
	}
	const nextDeck: OsPresentationDeck = {
		...deck,
		slides,
		activeSlideId: slides.some((slide) => slide.id === deck.activeSlideId)
			? deck.activeSlideId
			: (slides[0]?.id ?? deck.activeSlideId),
	};
	const next = OsOutputContentSchema.parse({
		kind: "presentation",
		slides: projectPresentationDeck(nextDeck),
		deck: nextDeck,
	});
	if (next.kind !== "presentation") throw new Error("Expected presentation");
	return next;
}
