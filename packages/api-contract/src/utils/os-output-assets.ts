/**
 * Images of a file are stored apart from its content. The content names each
 * one by the SHA-256 of its bytes: `tedix-asset:<sha256>`. This module has no
 * schema imports so an editor bundle can use it.
 */

export const OS_OUTPUT_ASSET_SCHEME = "tedix-asset:";

/** The largest image one file may store, in bytes. */
export const OS_OUTPUT_ASSET_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The longest embedded `data:` image a writer may send: the largest stored
 * image as base64 text, with room for the `data:` prefix. A save moves it out
 * of the content, so this bounds one request, not a stored file.
 */
export const OS_OUTPUT_EMBEDDED_IMAGE_MAX_CHARS = 7_100_000;

/**
 * The longest `data:` image a stored file keeps in its content. Longer ones
 * are stored as assets; a tiny inline icon stays where it is.
 */
export const OS_OUTPUT_INLINE_IMAGE_MAX_CHARS = 2_048;

export function outputAssetReference(sha256: string): string {
	return `${OS_OUTPUT_ASSET_SCHEME}${sha256}`;
}

/** The digest a reference names, or null when the string is not a reference. */
export function outputAssetDigest(
	source: string | null | undefined,
): string | null {
	const match = source && /^tedix-asset:([a-f0-9]{64})$/.exec(source);
	return match ? match[1]! : null;
}

/** Whether the source is an embedded image too large to stay in stored content. */
export function isLargeEmbeddedImage(source: string): boolean {
	return (
		source.length > OS_OUTPUT_INLINE_IMAGE_MAX_CHARS && /^data:/i.test(source)
	);
}

type RichNode = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: RichNode[];
};
type ImageContent = {
	kind: string;
	deck?: {
		slides: Array<{
			backgroundImage?: string;
			elements: Array<{ type: string; src?: string }>;
		}>;
	};
	slides?: Array<{
		canvas?: {
			backgroundImage?: string;
			elements?: Array<{ type: string; src?: string }>;
		};
	}>;
	richText?: { content?: RichNode[] };
};

/**
 * Visit every image source a presentation or document carries: slide element
 * `src`, slide `backgroundImage` and document image `attrs.src`. A string
 * returned by `visit` replaces the source in place.
 */
export function visitOutputImageSources(
	content: unknown,
	visit: (source: string) => string | void,
): void {
	const body = content as ImageContent;
	const slide = (canvas: {
		backgroundImage?: string;
		elements?: Array<{ type: string; src?: string }>;
	}) => {
		if (canvas.backgroundImage)
			canvas.backgroundImage =
				visit(canvas.backgroundImage) ?? canvas.backgroundImage;
		for (const element of canvas.elements ?? [])
			if ((element.type === "image" || element.type === "svg") && element.src)
				element.src = visit(element.src) ?? element.src;
	};
	if (body?.kind === "presentation") {
		for (const entry of body.deck?.slides ?? []) slide(entry);
		for (const entry of body.slides ?? [])
			if (entry.canvas) slide(entry.canvas);
	} else if (body?.kind === "document") {
		const node = (entry: RichNode) => {
			if (entry.type === "image" && typeof entry.attrs?.src === "string")
				entry.attrs.src = visit(entry.attrs.src) ?? entry.attrs.src;
			for (const child of entry.content ?? []) node(child);
		};
		for (const entry of body.richText?.content ?? []) node(entry);
	}
}

/** The distinct image sources of a file's content that satisfy `keep`. */
export function listOutputImageSources(
	content: unknown,
	keep: (source: string) => boolean = () => true,
): string[] {
	const found = new Set<string>();
	visitOutputImageSources(content, (source) => {
		if (keep(source)) found.add(source);
	});
	return [...found];
}
