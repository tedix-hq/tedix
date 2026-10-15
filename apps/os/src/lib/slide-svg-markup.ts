import { SLIDE_IMAGE_MAX_SOURCE } from "@/lib/slide-image-upload";

const SVG_DATA = /^data:image\/svg\+xml(;[^,]*)?,/i;

/**
 * An SVG element keeps its drawing as a data URI in `src`, so it renders
 * through `<img>`: scripts and handlers in pasted markup never run. These
 * convert between that source and the markup the inspector edits.
 */
export function svgMarkupFromSource(source: string | undefined): string {
	if (!source) return "";
	const match = SVG_DATA.exec(source);
	if (!match) return "";
	const payload = source.slice(match[0].length);
	try {
		if (match[1]?.toLowerCase().includes("base64")) {
			const bytes = Uint8Array.from(atob(payload), (char) =>
				char.charCodeAt(0),
			);
			return new TextDecoder().decode(bytes);
		}
		return decodeURIComponent(payload);
	} catch {
		return "";
	}
}

export type SvgSourceResult =
	| { ok: true; src: string | undefined }
	| { ok: false; error: string };

export function svgSourceFromMarkup(markup: string): SvgSourceResult {
	const trimmed = markup.trim();
	if (!trimmed) return { ok: true, src: undefined };
	if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(trimmed))
		return { ok: false, error: "SVG code must start with an <svg> element." };
	const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
	if (src.length > SLIDE_IMAGE_MAX_SOURCE)
		return { ok: false, error: "This SVG is too large for a slide." };
	return { ok: true, src };
}
