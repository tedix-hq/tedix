/** Prepare portable document images without asking users to resize screenshots first. */
export async function prepareDocumentImage(file: File) {
	if (
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
	) {
		throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
	}
	const src = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("The image could not be read."));
		reader.readAsDataURL(file);
	});
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("The image could not be opened."));
		image.src = src;
	});
	const alt = file.name.replace(/\.[^.]+$/, "");
	const width = image.naturalWidth;
	const height = image.naturalHeight;
	if (!width || !height)
		throw new Error("The image has no readable dimensions.");
	// Keep portable small originals (and their animation/transparency) unchanged.
	// WebP is normalized even when small so the same document exports to Word.
	if (
		file.type !== "image/webp" &&
		src.length <= 256 * 1024 &&
		Math.max(width, height) <= 1600
	) {
		return { src, alt, width, height };
	}
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) throw new Error("This browser cannot resize images.");
	let scale = Math.min(1, 1600 / Math.max(width, height));
	for (let attempt = 0; attempt < 5; attempt++) {
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const png = canvas.toDataURL("image/png");
		if (png.startsWith("data:image/png;") && png.length <= 256 * 1024) {
			return { src: png, alt, width: canvas.width, height: canvas.height };
		}
		// JPEG cannot retain alpha. Composite onto the document's white paper,
		// rather than leaving formerly transparent pixels black in exports.
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		for (const quality of [0.86, 0.7, 0.5]) {
			const encoded = canvas.toDataURL("image/jpeg", quality);
			if (
				encoded.startsWith("data:image/jpeg;") &&
				encoded.length <= 256 * 1024
			) {
				return {
					src: encoded,
					alt,
					width: canvas.width,
					height: canvas.height,
				};
			}
		}
		scale *= 0.7;
	}
	throw new Error("This image is too large to embed. Try a smaller image.");
}
