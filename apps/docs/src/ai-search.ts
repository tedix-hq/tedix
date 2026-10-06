import type { DocsBuild, DocsSite } from "./types";

const METADATA_FIELDS = [
	{ field_name: "siteId", data_type: "text" as const },
	{ field_name: "buildId", data_type: "text" as const },
	{ field_name: "sourceRevision", data_type: "text" as const },
	{ field_name: "canonicalUrl", data_type: "text" as const },
	{ field_name: "pageTitle", data_type: "text" as const },
];

const OCR_INDEXING_OPTIONS = { use_ocr: true } as NonNullable<
	AiSearchConfig["indexing_options"]
> & { use_ocr: true };
const MULTIMODAL_EMBEDDING_MODEL = "@cf/qwen/qwen3-vl-embedding-2b";

const BINARY_CONTENT_TYPES = {
	".pdf": "application/pdf",
	".bmp": "image/bmp",
	".gif": "image/gif",
	".heic": "image/heic",
	".heif": "image/heif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".webp": "image/webp",
} as const;

const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_OCR_PDF_BYTES = 10 * 1024 * 1024;

function instanceId(siteId: string): string {
	return siteId.replaceAll("-", "").toLowerCase();
}

async function instance(namespace: AiSearchNamespace, siteId: string) {
	const id = instanceId(siteId);
	const current = namespace.get(id);
	try {
		const info = await current.info();
		const fields = new Set(
			(info.custom_metadata ?? []).map((field) =>
				field.field_name.toLowerCase(),
			),
		);
		const missingMetadata = METADATA_FIELDS.some(
			(field) => !fields.has(field.field_name.toLowerCase()),
		);
		const ocrEnabled = (
			info.indexing_options as
				| (NonNullable<AiSearchConfig["indexing_options"]> & {
						use_ocr?: boolean;
				  })
				| null
				| undefined
		)?.use_ocr;
		const needsMultimodalModel =
			info.embedding_model !== MULTIMODAL_EMBEDDING_MODEL;
		if (missingMetadata || ocrEnabled !== true || needsMultimodalModel) {
			await current.update({
				...(missingMetadata ? { custom_metadata: METADATA_FIELDS } : {}),
				...(ocrEnabled === true
					? {}
					: { indexing_options: OCR_INDEXING_OPTIONS }),
				...(needsMultimodalModel
					? { embedding_model: MULTIMODAL_EMBEDDING_MODEL }
					: {}),
			});
		}
		return current;
	} catch (error) {
		if (!String(error).includes("ai_search_not_found")) throw error;
	}
	return namespace.create({
		id,
		index_method: { vector: true, keyword: true },
		embedding_model: MULTIMODAL_EMBEDDING_MODEL,
		indexing_options: OCR_INDEXING_OPTIONS,
		custom_metadata: METADATA_FIELDS,
	});
}

function binaryContentType(path: string): string | null {
	const extension = /\.[^./]+$/.exec(path.toLowerCase())?.[0];
	return extension
		? (BINARY_CONTENT_TYPES[extension as keyof typeof BINARY_CONTENT_TYPES] ??
				null)
		: null;
}

async function itemKey(buildId: string, path: string): Promise<string> {
	const extension = /\.[^./]+$/.exec(path.toLowerCase())?.[0] ?? "";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(path),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${buildId}/${hex}${extension}`;
}

function canonicalUrl(site: DocsSite, path: string): string {
	let route = path.replace(/\.md$/i, "").replace(/\/index$/i, "");
	if (route === "index") route = "";
	return new URL(route ? `/${route}` : "/", site.canonicalUrl).toString();
}

function fallbackTitle(site: DocsSite, url: string): string {
	const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
	if (!segment) return site.title;
	const label = segment.replace(/\.[^.]+$/, "").replaceAll("-", " ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function readerMarkdown(markdown: string): string {
	return markdown
		.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
		.replace(
			/^\s*> Documentation Index\r?\n> Fetch the complete documentation index at: [^\r\n]*\r?\n> Use this file to discover all available pages before exploring further\.\r?\n/,
			"",
		)
		.replace(/\r?\nSource: https?:\/\/[^\r\n]+\s*$/, "")
		.trim();
}

function readerSnippet(markdown: string): string {
	return readerMarkdown(markdown)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/```[^\r\n]*/g, " ")
		.replace(/^#{1,6}\s+[^\r\n]+$/gm, " ")
		.replace(/^>\s?/gm, "")
		.replace(/\*\*/g, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

export async function indexPublicDocsBuild(
	env: { DOCS_BUILDS: R2Bucket; DOCS_AI_SEARCH?: AiSearchNamespace },
	site: DocsSite,
	build: DocsBuild,
): Promise<{ accepted: number; buildId: string; sourceRevision: string }> {
	if (site.accessMode !== "public") {
		throw new Error("Authenticated documentation sites cannot be AI indexed");
	}
	if (!env.DOCS_AI_SEARCH) throw new Error("Docs AI Search is not configured");
	if (!build.manifestKey || !build.sourceRevision) {
		throw new Error("Completed immutable build metadata is required");
	}
	const manifestObject = await env.DOCS_BUILDS.get(build.manifestKey);
	if (!manifestObject) throw new Error("Docs build manifest not found");
	const manifest = (await manifestObject.json()) as {
		buildId?: string;
		sourceRevision?: string;
		files?: unknown;
	};
	if (
		manifest.buildId !== build.id ||
		manifest.sourceRevision !== build.sourceRevision ||
		!Array.isArray(manifest.files)
	) {
		throw new Error(
			"Docs build manifest does not match the immutable revision",
		);
	}
	const indexablePaths = manifest.files.filter(
		(path): path is string =>
			typeof path === "string" &&
			(path.endsWith(".md") || binaryContentType(path) !== null),
	);
	const search = await instance(env.DOCS_AI_SEARCH, site.id);
	let accepted = 0;
	for (const path of indexablePaths) {
		const object = await env.DOCS_BUILDS.get(
			`sites/${site.id}/builds/${build.id}/${path}`,
		);
		if (!object) throw new Error(`Docs build object missing: ${path}`);
		const url = canonicalUrl(site, path);
		const contentType = binaryContentType(path);
		let content: string | Blob;
		let pageTitle: string;
		if (contentType) {
			const maxBytes =
				contentType === "application/pdf"
					? MAX_OCR_PDF_BYTES
					: MAX_BINARY_BYTES;
			if (object.size > maxBytes) {
				throw new Error(
					`Docs AI Search input exceeds ${maxBytes} bytes: ${path}`,
				);
			}
			content = new Blob([await object.arrayBuffer()], { type: contentType });
			pageTitle = fallbackTitle(site, url);
		} else {
			content = readerMarkdown(await object.text());
			pageTitle =
				content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackTitle(site, url);
		}
		await search.items.upload(await itemKey(build.id, path), content, {
			metadata: {
				siteId: site.id,
				buildId: build.id,
				sourceRevision: build.sourceRevision,
				canonicalUrl: url,
				pageTitle,
			},
		});
		accepted += 1;
	}
	return { accepted, buildId: build.id, sourceRevision: build.sourceRevision };
}

export async function searchPublicDocs(
	env: { DOCS_AI_SEARCH?: AiSearchNamespace },
	site: DocsSite,
	build: DocsBuild,
	query: string,
	limit: number,
) {
	if (site.accessMode !== "public") {
		throw new Error(
			"Authenticated documentation sites are excluded from search",
		);
	}
	if (!env.DOCS_AI_SEARCH) throw new Error("Docs AI Search is not configured");
	if (site.activeBuildId !== build.id || !build.sourceRevision) {
		throw new Error("Search requires the active immutable build revision");
	}
	const retrievalStarted = performance.now();
	const response = await env.DOCS_AI_SEARCH.get(instanceId(site.id)).search({
		query,
		ai_search_options: {
			retrieval: {
				retrieval_type: "hybrid",
				max_num_results: Math.min(limit * 3, 50),
				match_threshold: 0.3,
				// Filter before retrieval so older builds cannot exhaust the result cap.
				filters: {
					// AI Search stores custom field names in lowercase.
					siteid: site.id,
					buildid: build.id,
					sourcerevision: build.sourceRevision,
				},
			},
		},
	});
	const retrievalLatencyMs = Math.round(performance.now() - retrievalStarted);
	const candidates = response.chunks
		.filter(
			(chunk) =>
				chunk.item.metadata?.siteId === site.id &&
				chunk.item.metadata?.buildId === build.id &&
				chunk.item.metadata?.sourceRevision === build.sourceRevision &&
				typeof chunk.item.metadata?.canonicalUrl === "string",
		)
		.map((chunk) => ({
			url: chunk.item.metadata?.canonicalUrl as string,
			title:
				typeof chunk.item.metadata?.pageTitle === "string" &&
				chunk.item.metadata.pageTitle.trim()
					? chunk.item.metadata.pageTitle
					: fallbackTitle(site, chunk.item.metadata?.canonicalUrl as string),
			snippet: readerSnippet(chunk.text),
			score: chunk.score,
			buildId: build.id,
			sourceRevision: build.sourceRevision,
		}));
	const citations = [
		...new Map(candidates.map((citation) => [citation.url, citation])).values(),
	].slice(0, limit);
	return {
		query,
		citations,
		retrievalLatencyMs,
		buildId: build.id,
		sourceRevision: build.sourceRevision,
	};
}
