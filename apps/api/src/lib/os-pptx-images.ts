import { Buffer } from "node:buffer";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	runBrowserQuickAction,
	isUsableScreenshot,
} from "../integrations/browser-run/client";
import { inlineOsExportImages } from "./os-export-images";
import { escapeHtml, OS_EXPORT_RESOURCE_WAIT } from "./os-output-html";

/** Keep CDN-negotiated WebP images readable by the native Office writer. */
export async function prepareOsPptxImages(
	content: OsOutputContent,
	browser: unknown,
): Promise<OsOutputContent> {
	const copy = await inlineOsExportImages(content);
	if (copy.kind !== "presentation") return copy;
	const converted = new Map<string, string>();
	const png = async (
		source: string,
		width: number,
		height: number,
		fit: "contain" | "cover",
	) => {
		if (!source.startsWith("data:image/webp;")) return source;
		width = Math.ceil(width);
		height = Math.ceil(height);
		const key = `${width}:${height}:${fit}:${source}`;
		const cached = converted.get(key);
		if (cached) return cached;
		const response = await runBrowserQuickAction(browser, "screenshot", {
			html: `<!doctype html><html><head><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;object-fit:${fit}}</style></head><body><img alt="" src="${escapeHtml(source)}"></body></html>`,
			viewport: { width, height, deviceScaleFactor: 1 },
			screenshotOptions: { type: "png", omitBackground: true, fullPage: false },
			...OS_EXPORT_RESOURCE_WAIT,
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		const type = response.headers.get("content-type") ?? "";
		if (!type.startsWith("image/png") || !isUsableScreenshot(bytes, type))
			throw new Error("PPTX image conversion returned an invalid PNG");
		const result = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
		converted.set(key, result);
		return result;
	};
	for (const slide of copy.deck?.slides ?? []) {
		if (slide.backgroundImage)
			slide.backgroundImage = await png(
				slide.backgroundImage,
				1200,
				675,
				"cover",
			);
		for (const element of slide.elements) {
			if (element.type === "image" && element.src)
				element.src = await png(
					element.src,
					element.width,
					element.height,
					element.style.fit ?? "contain",
				);
		}
	}
	return copy;
}
