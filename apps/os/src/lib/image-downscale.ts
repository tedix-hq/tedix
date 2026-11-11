import {
	OS_IMAGE_MAX_DIMENSION,
	OS_IMAGE_MAX_GIF_BYTES,
	OS_IMAGE_MAX_STILL_BYTES,
} from "@tedix/api-contract/utils/os-output-limits";

/**
 * Prepare a picture someone inserts into a Doc or a slide. It is stored with
 * the file, apart from its content, so these bounds only keep one picture a
 * quick upload and a quick download for everyone who opens the file.
 */

/** JPEG qualities tried in turn before a picture is refused. */
const JPEG_QUALITIES = [0.86, 0.74, 0.62, 0.5];

export const IMAGE_TOO_LARGE = "This image is too large. Try a smaller image.";

/** The bytes a base64 data URL carries. */
export function dataUrlBytes(dataUrl: string): number {
	const comma = dataUrl.indexOf(",");
	const body = dataUrl.length - comma - 1;
	if (!/;base64$/i.test(dataUrl.slice(0, Math.max(comma, 0)))) return body;
	const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
	return Math.floor((body * 3) / 4) - padding;
}

/** The longest data URL a still image may be: its byte limit as base64. */
export const IMAGE_MAX_STILL_CHARS =
	Math.ceil((OS_IMAGE_MAX_STILL_BYTES * 4) / 3) + 64;

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

/**
 * Read a PNG, JPEG, GIF or WebP file as a data URL ready to store.
 *
 * A picture within the limits is kept as uploaded: up to 1600 px on its long
 * side and about 1.4 MB, or 2.7 MB for a GIF so it keeps its animation.
 * Anything larger is scaled down to 1600 px. A PNG stays a PNG when that
 * fits, because transparency matters more than the last kilobytes; otherwise
 * the picture becomes a JPEG on white, at falling quality, and is refused
 * only when the lowest quality is still too large.
 */
export async function fileToStoredImage(file: File): Promise<string> {
	const original = await readDataUrl(file);
	const image = await loadImage(original);
	const longest = Math.max(image.naturalWidth, image.naturalHeight);
	if (!longest) throw new Error("The image has no readable dimensions.");
	const bytes = dataUrlBytes(original);
	if (file.type === "image/gif" && bytes <= OS_IMAGE_MAX_GIF_BYTES)
		return original;
	if (longest <= OS_IMAGE_MAX_DIMENSION && bytes <= OS_IMAGE_MAX_STILL_BYTES)
		return original;
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) throw new Error("This browser cannot resize images.");
	const scale = Math.min(1, OS_IMAGE_MAX_DIMENSION / longest);
	canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
	const fits = (encoded: string, type: string) =>
		encoded.startsWith(`data:${type};`) &&
		dataUrlBytes(encoded) <= OS_IMAGE_MAX_STILL_BYTES;
	if (file.type === "image/png") {
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const encoded = canvas.toDataURL("image/png");
		if (fits(encoded, "image/png")) return encoded;
	}
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	for (const quality of JPEG_QUALITIES) {
		const encoded = canvas.toDataURL("image/jpeg", quality);
		if (fits(encoded, "image/jpeg")) return encoded;
	}
	throw new Error(IMAGE_TOO_LARGE);
}
