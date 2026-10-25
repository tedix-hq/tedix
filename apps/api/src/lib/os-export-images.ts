import { Buffer } from "node:buffer";
import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { guardedFetch, validateUrl } from "@tedix/ssrf-guard";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
]);

/** Inline image bytes so Browser Rendering never visits caller-chosen origins. */
export async function fetchOsExportImage(source: string): Promise<string> {
	const response = await guardedFetch(
		source,
		{
			signal: AbortSignal.timeout(10_000),
			headers: { Accept: [...IMAGE_TYPES].join(", ") },
		},
		{
			// The public website serves authored images; other Tedix service hosts
			// remain blocked. Apply this narrower exception at every redirect hop.
			allowTedixHosts: true,
			fetchFn: (url, init) => {
				const target = new URL(url);
				const error = validateUrl(url, {
					allowTedixHosts: target.hostname === "tedix.dev",
				});
				if (error || target.username || target.password)
					throw new Error(error ?? "Image URL credentials are forbidden");
				return fetch(url, init);
			},
		},
	);
	const type = response.headers
		.get("content-type")
		?.split(";")[0]
		?.trim()
		.toLowerCase();
	if (
		!response.ok ||
		!type ||
		!IMAGE_TYPES.has(type) ||
		Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
	) {
		await response.body?.cancel();
		throw new Error(
			"Export image must be a public HTTPS raster image of at most 10 MB",
		);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Export image has no body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_IMAGE_BYTES) throw new Error("Export image exceeds 10 MB");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = Buffer.concat(chunks);
	validateExportImage(bytes, type);
	return `data:${type};base64,${bytes.toString("base64")}`;
}

function validateExportImage(bytes: Buffer, type: string): void {
	if (bytes.length === 0) throw new Error("Export image is empty");
	if (bytes.length > MAX_IMAGE_BYTES)
		throw new Error("Export image exceeds 10 MB");
	if (type === "image/svg+xml") {
		// Inspect XML character references too: they can hide CSS tokens or escapes.
		// This is an inspection copy; successful exports preserve the original bytes.
		const svg = bytes
			.toString("utf8")
			.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code: string) => {
				const value = /^x/i.test(code)
					? Number.parseInt(code.slice(1), 16)
					: Number.parseInt(code, 10);
				return value <= 0x10ffff ? String.fromCodePoint(value) : entity;
			})
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'");
		if (
			!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg) ||
			// CSS escapes are outside the export subset, even for local references.
			svg.includes("\\") ||
			/<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed)\b|\son\w+\s*=|javascript:|@import/i.test(
				svg,
			) ||
			Array.from(svg.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)/gi)).some(
				(match) => !match[1]!.startsWith("#"),
			) ||
			Array.from(svg.matchAll(/url\(([^)]*)\)/gi)).some(
				(match) =>
					!match[1]!
						.trim()
						.replace(/^["']|["']$/g, "")
						.startsWith("#"),
			)
		) {
			throw new Error(
				"Export SVG must be a self-contained image without active content",
			);
		}
	}
}

function validateInlineImage(source: string): void {
	const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(source);
	const type = match?.[1]?.toLowerCase();
	if (!match || !type || !IMAGE_TYPES.has(type))
		throw new Error("Invalid export image data URL");
	// Percent decoding must preserve binary octets as well as UTF-8 SVG text.
	const payload = Buffer.from(match[3]!, "utf8")
		.toString("latin1")
		.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
	const bytes = Buffer.from(
		/;base64$/i.test(match[2]!) ? atob(payload) : payload,
		"latin1",
	);
	validateExportImage(bytes, type);
}

export async function inlineOsExportImages<T extends OsOutputContent>(
	content: T,
): Promise<T> {
	const copy = structuredClone(content);
	const sources = new Map<string, string>();
	const inline = async (source: string) => {
		let result = sources.get(source);
		if (!result) {
			if (/^data:/i.test(source)) {
				validateInlineImage(source);
				result = source;
			} else {
				result = await fetchOsExportImage(source);
			}
			sources.set(source, result);
		}
		return result;
	};
	if (copy.kind === "presentation") {
		for (const slide of copy.deck?.slides ?? []) {
			if (slide.backgroundImage)
				slide.backgroundImage = await inline(slide.backgroundImage);
			for (const element of slide.elements) {
				if (
					(element.type === "image" || element.type === "svg") &&
					element.src
				) {
					element.src = await inline(element.src);
				}
			}
		}
	} else if (copy.kind === "document") {
		const visit = async (node: OsRichTextNode) => {
			if (node.type === "image" && typeof node.attrs?.src === "string") {
				node.attrs.src = await inline(node.attrs.src);
			}
			for (const child of node.content ?? []) await visit(child);
		};
		for (const node of copy.richText?.content ?? []) await visit(node);
	}
	return copy;
}
