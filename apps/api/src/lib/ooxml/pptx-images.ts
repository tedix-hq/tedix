import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { fetchOsExportImage } from "../os-export-images";
import { xmlEscape } from "./zip";

export interface PptxImage {
	name: string;
	data: Uint8Array;
	width: number;
	height: number;
}

function imageDimensions(bytes: Uint8Array, png: boolean) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (png && bytes.length >= 24)
		return { width: view.getUint32(16), height: view.getUint32(20) };
	let offset = 2;
	while (!png && offset + 8 < bytes.length && bytes[offset] === 255) {
		const marker = bytes[offset + 1]!;
		const length = view.getUint16(offset + 2);
		if (
			[
				192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
			].includes(marker)
		)
			return {
				height: view.getUint16(offset + 5),
				width: view.getUint16(offset + 7),
			};
		if (length < 2) break;
		offset += length + 2;
	}
	throw new Error("PPTX image has no readable dimensions");
}

export async function collectPptxImages(
	slides: OsPresentationCanvasSlide[],
): Promise<Map<string, PptxImage>> {
	const images = new Map<string, PptxImage>();
	for (const slide of slides) {
		for (const element of slide.elements) {
			if (element.type !== "image" || !element.src || images.has(element.src))
				continue;
			const source = element.src.startsWith("data:")
				? element.src
				: await fetchOsExportImage(element.src);
			const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
				source,
			);
			if (!match)
				throw new Error(
					"PPTX images must be PNG or JPEG; SVG elements are omitted",
				);
			if (match[2]!.length > 14 * 1024 * 1024)
				throw new Error("PPTX image exceeds 10 MB");
			const data = Uint8Array.from(atob(match[2]!), (character) =>
				character.charCodeAt(0),
			);
			const png = match[1]!.toLowerCase() === "png";
			if (
				png
					? ![137, 80, 78, 71, 13, 10, 26, 10].every(
							(byte, index) => data[index] === byte,
						)
					: !(data[0] === 255 && data[1] === 216 && data[2] === 255)
			)
				throw new Error("Invalid PPTX image bytes");
			if (data.byteLength > 10 * 1024 * 1024)
				throw new Error("PPTX image exceeds 10 MB");
			const dimensions = imageDimensions(data, png);
			if (dimensions.width <= 0 || dimensions.height <= 0)
				throw new Error("Invalid PPTX image dimensions");
			images.set(element.src, {
				name: `image${images.size + 1}.${png ? "png" : "jpeg"}`,
				data,
				...dimensions,
			});
		}
	}
	return images;
}

export function pptxPicture(
	element: OsPresentationElement,
	id: number,
	relationshipId: string,
	image: PptxImage,
): string {
	const scale = Math.min(
		element.width / image.width,
		element.height / image.height,
	);
	const width = image.width * scale;
	const height = image.height * scale;
	const x = element.x + (element.width - width) / 2;
	const y = element.y + (element.height - height) / 2;
	const rotation = element.style.rotation
		? ` rot="${Math.round(element.style.rotation * 60000)}"`
		: "";
	return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(element.id)}" descr="${xmlEscape(element.text ?? "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm${rotation}><a:off x="${Math.round(x * 10160)}" y="${Math.round(y * 10160)}"/><a:ext cx="${Math.max(1, Math.round(width * 10160))}" cy="${Math.max(1, Math.round(height * 10160))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
