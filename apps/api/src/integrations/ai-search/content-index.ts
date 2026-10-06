import type { ContentNativeMediaType } from "@tedix/api-contract/contracts/content";
import type { DbClient } from "@tedix/db/client";
import {
	updateContentSourceDocumentProjection,
	upsertContentSourceDocument,
} from "@tedix/db/queries/content-sources";

const CONTENT_METADATA_FIELDS = [
	{ field_name: "canonicalUrl", data_type: "text" as const },
	{ field_name: "sourceRevision", data_type: "text" as const },
	{ field_name: "visibility", data_type: "text" as const },
	{ field_name: "objectKey", data_type: "text" as const },
	{ field_name: "digest", data_type: "text" as const },
];

export interface ContentIndexEnv {
	CONTENT_CMS_BUCKET: R2Bucket;
	CONTENT_AI_SEARCH: AiSearchNamespace;
}

interface ContentDocumentBase {
	appId: string;
	appSlug: string;
	sourceId?: string | null;
	canonicalUrl: string;
	title: string;
	contentType: string;
	visibility: "public" | "private" | "disabled";
	sourceRevision?: string;
}

export type IndexContentDocumentInput = ContentDocumentBase &
	(
		| { markdown: string; nativeFile?: never }
		| {
				nativeFile: {
					name: string;
					content: ArrayBuffer | Blob;
					mediaType: ContentNativeMediaType;
				};
				markdown?: never;
		  }
	);

export function contentSearchInstanceId(appId: string): string {
	const instanceId = appId.replaceAll("-", "").toLowerCase();
	if (
		!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(instanceId) ||
		instanceId.length > 32
	) {
		throw new Error(`App ID cannot form an AI Search instance ID: ${appId}`);
	}
	return instanceId;
}

async function sha256(value: string | ArrayBuffer): Promise<string> {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

const OCR_INDEXING_OPTIONS = { use_ocr: true } as NonNullable<
	AiSearchConfig["indexing_options"]
> & { use_ocr: true };
const MULTIMODAL_EMBEDDING_MODEL = "@cf/qwen/qwen3-vl-embedding-2b";

async function getOrCreateContentSearchInstance(
	namespace: AiSearchNamespace,
	appId: string,
): Promise<AiSearchInstance> {
	const id = contentSearchInstanceId(appId);
	const existing = namespace.get(id);
	try {
		const info = await existing.info();
		const fieldNames = new Set(
			(info.custom_metadata ?? []).map((field) => field.field_name),
		);
		const missingMetadata = CONTENT_METADATA_FIELDS.some(
			(field) => !fieldNames.has(field.field_name),
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
			await existing.update({
				...(missingMetadata
					? { custom_metadata: CONTENT_METADATA_FIELDS }
					: {}),
				...(ocrEnabled === true
					? {}
					: { indexing_options: OCR_INDEXING_OPTIONS }),
				...(needsMultimodalModel
					? { embedding_model: MULTIMODAL_EMBEDDING_MODEL }
					: {}),
			});
		}
		return existing;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("ai_search_not_found")) {
			throw error;
		}
	}

	try {
		return await namespace.create({
			id,
			index_method: { vector: true, keyword: true },
			embedding_model: MULTIMODAL_EMBEDDING_MODEL,
			indexing_options: OCR_INDEXING_OPTIONS,
			custom_metadata: CONTENT_METADATA_FIELDS,
		});
	} catch (createError) {
		// Concurrent first writes can race instance creation. The winner's
		// instance is safe to reuse because the ID is derived from the app UUID.
		const raced = namespace.get(id);
		try {
			await raced.info();
		} catch {
			throw createError;
		}
		return raced;
	}
}

function portableMarkdown(
	input: ContentDocumentBase & { markdown: string },
): string {
	const yaml = (value: string) => JSON.stringify(value);
	return [
		"---",
		`title: ${yaml(input.title)}`,
		`app_slug: ${yaml(input.appSlug)}`,
		`content_type: ${yaml(input.contentType)}`,
		`source_url: ${yaml(input.canonicalUrl)}`,
		`source_id: ${yaml(input.sourceId ?? "ingest")}`,
		"---",
		"",
		input.markdown,
	].join("\n");
}

const EXTENSIONS_BY_MEDIA_TYPE: Record<ContentNativeMediaType, string> = {
	"application/pdf": ".pdf",
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/heic": ".heic",
	"image/heif": ".heif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/tiff": ".tiff",
	"image/webp": ".webp",
};

const MAX_NATIVE_BYTES = 4 * 1024 * 1024;
const MAX_OCR_PDF_BYTES = 10 * 1024 * 1024;

async function nativeContent(input: IndexContentDocumentInput): Promise<{
	bytes: ArrayBuffer;
	blob: Blob;
	extension: string;
}> {
	if (!input.nativeFile) throw new Error("Native content input is required");
	if (!input.nativeFile.name.trim()) {
		throw new Error("Native content filename is required");
	}
	const bytes =
		input.nativeFile.content instanceof Blob
			? await input.nativeFile.content.arrayBuffer()
			: input.nativeFile.content;
	const maxBytes =
		input.nativeFile.mediaType === "application/pdf"
			? MAX_OCR_PDF_BYTES
			: MAX_NATIVE_BYTES;
	if (bytes.byteLength > maxBytes) {
		throw new Error(
			`Native AI Search input exceeds ${maxBytes} bytes: ${input.nativeFile.name}`,
		);
	}
	return {
		bytes,
		blob: new Blob([bytes], { type: input.nativeFile.mediaType }),
		extension: EXTENSIONS_BY_MEDIA_TYPE[input.nativeFile.mediaType],
	};
}

export async function indexContentDocument(
	db: DbClient,
	env: ContentIndexEnv,
	input: IndexContentDocumentInput,
): Promise<{ id: string; objectKey: string; digest: string; itemId: string }> {
	const canonicalUrl = new URL(input.canonicalUrl).toString();
	let content: string | Blob;
	let digestInput: string | ArrayBuffer;
	let extension: string;
	if (input.nativeFile) {
		const native = await nativeContent(input);
		content = native.blob;
		digestInput = native.bytes;
		extension = native.extension;
	} else {
		content = portableMarkdown({
			...input,
			canonicalUrl,
			markdown: input.markdown,
		});
		digestInput = content;
		extension = ".md";
	}
	const [urlDigest, digest] = await Promise.all([
		sha256(canonicalUrl),
		sha256(digestInput),
	]);
	const sourceRevision = input.sourceRevision ?? `sha256:${digest}`;
	const objectKey = `${input.appSlug}/documents/${urlDigest.slice(0, 32)}${extension}`;
	if (canonicalUrl.length > 500) {
		throw new Error(
			"Canonical URL exceeds AI Search's 500-character metadata limit",
		);
	}
	const documentId = crypto.randomUUID();

	await env.CONTENT_CMS_BUCKET.put(objectKey, content, {
		httpMetadata: {
			contentType:
				content instanceof Blob ? content.type : "text/markdown; charset=utf-8",
		},
		customMetadata: {
			canonicalUrl,
			sourceRevision,
			visibility: input.visibility,
			digest,
		},
	});

	const document = await upsertContentSourceDocument(db, {
		id: documentId,
		appId: input.appId,
		sourceId: input.sourceId ?? null,
		canonicalUrl,
		sourceRevision,
		visibility: input.visibility,
		objectKey,
		digest,
		title: input.title,
		contentType: input.contentType,
		aiSearchStatus: "pending",
	});

	try {
		const instance = await getOrCreateContentSearchInstance(
			env.CONTENT_AI_SEARCH,
			input.appId,
		);
		// AI Search indexing is asynchronous. Persist the accepted item immediately
		// instead of holding the ingestion step open while the projection is built:
		// production indexing can outlive a Worker request, even though the upload
		// itself has succeeded and the item becomes searchable moments later.
		const item = await instance.items.upload(
			`${urlDigest.slice(0, 32)}${extension}`,
			content,
			{
				metadata: {
					canonicalUrl,
					sourceRevision,
					visibility: input.visibility,
					objectKey,
					digest,
				},
			},
		);
		await updateContentSourceDocumentProjection(db, document.id, {
			aiSearchItemId: item.id,
			aiSearchStatus:
				item.status === "error"
					? "failed"
					: item.status === "completed"
						? "completed"
						: "pending",
			aiSearchError: item.error ?? null,
		});
		return { id: document.id, objectKey, digest, itemId: item.id };
	} catch (error) {
		await updateContentSourceDocumentProjection(db, document.id, {
			aiSearchStatus: "failed",
			aiSearchError: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
