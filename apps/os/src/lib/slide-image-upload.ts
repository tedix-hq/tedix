import { PRESENTATION_HEIGHT, PRESENTATION_WIDTH } from "@/lib/output-models";

/**
 * The element schema allows a 1.5 MB `src`, but the edit that inserts it has
 * to cross the collab socket, whose frames stop at 1 MiB (`MAX_MESSAGE_BYTES`
 * in `src/collab/protocol.ts`). Leave room for the rest of the change.
 */
export const SLIDE_IMAGE_MAX_SOURCE = 900_000;
const MAX_IMAGE_DIMENSION = 1920;
export const SLIDE_IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
] as const;

/** The first image file a drop or a clipboard paste carries, if any. */
export function slideImageFile(
	transfer: Pick<DataTransfer, "files" | "items"> | null,
): File | null {
	const isImage = (type: string) =>
		(SLIDE_IMAGE_TYPES as readonly string[]).includes(type);
	for (const file of Array.from(transfer?.files ?? []))
		if (isImage(file.type)) return file;
	for (const item of Array.from(transfer?.items ?? [])) {
		if (item.kind !== "file" || !isImage(item.type)) continue;
		const file = item.getAsFile();
		if (file) return file;
	}
	return null;
}

function readDataUrl(file: File) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("The image could not be read."));
		reader.readAsDataURL(file);
	});
}

function loadImage(src: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("The image could not be opened."));
		image.src = src;
	});
}

const TOO_LARGE = "This image is too large for a slide. Try a smaller image.";

/**
 * Embed an image file as a data URL that fits the element schema. SVG stays
 * verbatim. A raster image within the size limits is kept as uploaded, so a
 * small GIF keeps its animation. Anything larger is downscaled through a
 * canvas: a PNG stays a PNG (transparency matters more on a slide than the
 * last kilobytes), other formats become JPEG on white.
 */
export async function fileToSlideImageSource(file: File): Promise<string> {
	if (!(SLIDE_IMAGE_TYPES as readonly string[]).includes(file.type))
		throw new Error("Choose a PNG, JPEG, GIF, WebP or SVG image.");
	const original = await readDataUrl(file);
	if (file.type === "image/svg+xml") {
		if (original.length > SLIDE_IMAGE_MAX_SOURCE) throw new Error(TOO_LARGE);
		return original;
	}
	const image = await loadImage(original);
	const longest = Math.max(image.naturalWidth, image.naturalHeight);
	if (!longest) throw new Error("The image has no readable dimensions.");
	if (
		longest <= MAX_IMAGE_DIMENSION &&
		original.length <= SLIDE_IMAGE_MAX_SOURCE
	)
		return original;
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) throw new Error("This browser cannot resize images.");
	const png = file.type === "image/png";
	let scale = Math.min(1, MAX_IMAGE_DIMENSION / longest);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		context.clearRect(0, 0, canvas.width, canvas.height);
		if (!png) {
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, canvas.width, canvas.height);
		}
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const encoded = png
			? canvas.toDataURL("image/png")
			: canvas.toDataURL("image/jpeg", 0.85);
		if (
			encoded.startsWith(png ? "data:image/png;" : "data:image/jpeg;") &&
			encoded.length <= SLIDE_IMAGE_MAX_SOURCE
		)
			return encoded;
		scale *= 0.75;
	}
	throw new Error(TOO_LARGE);
}

/** The slide coordinates under a pointer, given the canvas's on-screen box. */
export function slidePointFromClient(
	clientX: number,
	clientY: number,
	rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): { x: number; y: number } {
	if (!rect.width || !rect.height)
		return { x: PRESENTATION_WIDTH / 2, y: PRESENTATION_HEIGHT / 2 };
	return {
		x: ((clientX - rect.left) / rect.width) * PRESENTATION_WIDTH,
		y: ((clientY - rect.top) / rect.height) * PRESENTATION_HEIGHT,
	};
}

/** Top-left position that centers a box on a point while keeping it on the slide. */
export function centeredSlidePosition(
	center: { x: number; y: number },
	size: { width: number; height: number },
): { x: number; y: number } {
	const clamp = (value: number, max: number) =>
		Math.round(Math.max(0, Math.min(max, value)));
	return {
		x: clamp(center.x - size.width / 2, PRESENTATION_WIDTH - size.width),
		y: clamp(center.y - size.height / 2, PRESENTATION_HEIGHT - size.height),
	};
}
