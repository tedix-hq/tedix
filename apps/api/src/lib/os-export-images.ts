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
]);

/** Inline raster bytes so Browser Rendering never visits caller-chosen origins. */
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
	if (size === 0) throw new Error("Export image is empty");
	return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
}

export async function inlineOsExportImages(
	content: OsOutputContent,
): Promise<OsOutputContent> {
	const copy = structuredClone(content);
	const sources = new Map<string, string>();
	const inline = async (source: string) => {
		if (/^data:image\/(?:png|jpeg|gif|webp);/i.test(source)) return source;
		let result = sources.get(source);
		if (!result) {
			result = await fetchOsExportImage(source);
			sources.set(source, result);
		}
		return result;
	};
	if (copy.kind === "presentation") {
		for (const slide of copy.deck?.slides ?? []) {
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
