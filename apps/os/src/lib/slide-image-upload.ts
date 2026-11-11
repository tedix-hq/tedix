import { PRESENTATION_HEIGHT, PRESENTATION_WIDTH } from "@/lib/output-models";
import {
	fileToStoredImage,
	IMAGE_MAX_STILL_CHARS,
	IMAGE_TOO_LARGE,
} from "@/lib/image-downscale";

/** The longest data URL an inserted slide image may be. */
export const SLIDE_IMAGE_MAX_SOURCE = IMAGE_MAX_STILL_CHARS;
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

function readText(file: File) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("The image could not be read."));
		reader.readAsDataURL(file);
	});
}

const TOO_LARGE = "This image is too large for a slide. Try a smaller image.";

/**
 * Read an image file as a data URL ready to store with the file. SVG stays
 * verbatim; every other format follows the shared picture rules
 * (`fileToStoredImage`): kept as uploaded within the limits, scaled down to
 * 1600 px otherwise.
 */
export async function fileToSlideImageSource(file: File): Promise<string> {
	if (!(SLIDE_IMAGE_TYPES as readonly string[]).includes(file.type))
		throw new Error("Choose a PNG, JPEG, GIF, WebP or SVG image.");
	if (file.type === "image/svg+xml") {
		const original = await readText(file);
		if (original.length > SLIDE_IMAGE_MAX_SOURCE) throw new Error(TOO_LARGE);
		return original;
	}
	try {
		return await fileToStoredImage(file);
	} catch (error) {
		if (error instanceof Error && error.message === IMAGE_TOO_LARGE)
			throw new Error(TOO_LARGE);
		throw error;
	}
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
