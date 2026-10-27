import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";

export function presentationImageDimensions(
	source: string,
): { width: number; height: number } | undefined {
	const encoded = source.split(",")[1];
	if (!encoded) return undefined;
	const bytes = Uint8Array.from(atob(encoded), (character) =>
		character.charCodeAt(0),
	);
	const view = new DataView(bytes.buffer);
	if (source.startsWith("data:image/png;") && bytes.length >= 24)
		return { width: view.getUint32(16), height: view.getUint32(20) };
	if (source.startsWith("data:image/gif;") && bytes.length >= 10)
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (source.startsWith("data:image/svg+xml;")) {
		// Only the root element sizes the image; child shapes and attributes
		// such as stroke-width also carry width/height.
		const xml =
			/<svg\b([^>]*)>/i.exec(new TextDecoder().decode(bytes))?.[1] ?? "";
		let width = Number(
			/(?:^|\s)width\s*=\s*(["'])\s*([\d.]+)\s*\1/.exec(xml)?.[2],
		);
		let height = Number(
			/(?:^|\s)height\s*=\s*(["'])\s*([\d.]+)\s*\1/.exec(xml)?.[2],
		);
		if (
			Number.isFinite(width) &&
			width > 0 &&
			Number.isFinite(height) &&
			height > 0
		)
			return { width, height };
		const viewBox =
			/\bviewBox\s*=\s*(["'])\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\1/.exec(
				xml,
			);
		width = Number(viewBox?.[2]);
		height = Number(viewBox?.[3]);
		if (
			Number.isFinite(width) &&
			width > 0 &&
			Number.isFinite(height) &&
			height > 0
		)
			return { width, height };
	}
	if (source.startsWith("data:image/jpeg;")) {
		for (let offset = 2; offset + 9 < bytes.length;) {
			if (bytes[offset] !== 0xff) break;
			const marker = bytes[offset + 1]!;
			const size = view.getUint16(offset + 2);
			if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker))
				return {
					width: view.getUint16(offset + 7),
					height: view.getUint16(offset + 5),
				};
			if (size < 2) break;
			offset += 2 + size;
		}
	}
	return undefined;
}

export function pptxImageFrame(
	element: OsPresentationElement,
	size = presentationImageDimensions(element.src ?? ""),
): {
	element: OsPresentationElement;
	crop: string;
} {
	if (!size?.width || !size.height) return { element, crop: "" };
	const imageRatio = size.width / size.height,
		frameRatio = element.width / element.height;
	// The focal point is the fraction of the cropped-away slack on each axis:
	// 0 keeps the start edge, 1 keeps the end edge, 0.5 stays centered — the
	// same fractions `object-position` applies in the viewer and HTML exports.
	const focalX = element.props?.focalPoint?.x ?? 0.5,
		focalY = element.props?.focalPoint?.y ?? 0.5;
	if (element.style.fit === "cover") {
		const crop =
			imageRatio > frameRatio
				? {
						l: (1 - frameRatio / imageRatio) * focalX * 100000,
						r: (1 - frameRatio / imageRatio) * (1 - focalX) * 100000,
						t: 0,
						b: 0,
					}
				: {
						l: 0,
						r: 0,
						t: (1 - imageRatio / frameRatio) * focalY * 100000,
						b: (1 - imageRatio / frameRatio) * (1 - focalY) * 100000,
					};
		return {
			element,
			crop: `<a:srcRect l="${Math.round(crop.l)}" r="${Math.round(crop.r)}" t="${Math.round(crop.t)}" b="${Math.round(crop.b)}"/>`,
		};
	}
	const scale = Math.min(
		element.width / size.width,
		element.height / size.height,
	);
	const width = size.width * scale,
		height = size.height * scale;
	return {
		element: {
			...element,
			x: element.x + (element.width - width) * focalX,
			y: element.y + (element.height - height) * focalY,
			width,
			height,
		},
		crop: "",
	};
}
