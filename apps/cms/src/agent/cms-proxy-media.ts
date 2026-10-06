import {
	apiData,
	buildCmsAuthHeaderCandidates,
	callCmsRest,
	callTenantMcpTool,
	type CmsProxyContext,
	cmsApiBaseUrl,
	cmsAuthUnavailableToolResult,
	cmsDoFetch,
	EMDASH_DEFAULT_MAX_UPLOAD_BYTES,
	executeCmsRestRequest,
	hasTenantMcpCredential,
	tenantMcpError,
	type ToolResult,
} from "./cms-proxy-runtime";
import { unwrapCmsToolResult } from "./tool-result";
import { asRecord } from "@tedix/api-contract/utils/is-record";

// ---------------------------------------------------------------------------
// media_upload — native tenant MCP forwarding with authenticated REST fallback
//
// Emdash registers native MCP media_upload (base64, content-hash dedupe,
// MIME allowlist, upload size limit). The tenant
// /_emdash/api/mcp endpoint is bearer-only upstream, so the native path needs
// the org's provisioned Emdash PAT (cms_provision_service_key). Contexts
// without a PAT (human JWT / Site Builder internal auth) fall back to the multipart
// REST route, which runs the same hash/dedupe/enrichment pipeline but ignores
// alt/caption on POST. The native route takes alt, but a content-hash dedupe
// reuses stored metadata, so changed alt and any caption need media_update.
// ---------------------------------------------------------------------------

export async function mediaUpload(
	ctx: CmsProxyContext,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const filename = args.filename as string;
	const mimeType = args.mimeType as string | undefined;
	const dataBase64 = args.dataBase64 as string | undefined;
	const alt = args.alt as string | undefined;
	const caption = args.caption as string | undefined;

	if (!filename) {
		return {
			content: [
				{ type: "text", text: "[VALIDATION_ERROR] filename is required" },
			],
			isError: true,
		};
	}
	if ("url" in args) {
		return {
			content: [
				{
					type: "text",
					text: "[VALIDATION_ERROR] URL uploads are unsupported; provide dataBase64",
				},
			],
			isError: true,
		};
	}
	if (!dataBase64 || !mimeType) {
		return {
			content: [
				{
					type: "text",
					text: "[VALIDATION_ERROR] dataBase64 and mimeType are required",
				},
			],
			isError: true,
		};
	}
	if ((dataBase64.length * 3) / 4 > EMDASH_DEFAULT_MAX_UPLOAD_BYTES) {
		return tenantMcpError(
			"PAYLOAD_TOO_LARGE",
			"File exceeds maximum size of 50MB",
		);
	}

	if (hasTenantMcpCredential(ctx)) {
		return mediaUploadViaTenantMcp(ctx, {
			filename,
			mimeType,
			dataBase64,
			alt,
			caption,
		});
	}

	return mediaUploadViaRestMultipart(ctx, {
		filename,
		mimeType,
		dataBase64,
		alt,
		caption,
	});
}

async function mediaUploadViaTenantMcp(
	ctx: CmsProxyContext,
	input: {
		filename: string;
		mimeType: string;
		dataBase64: string;
		alt: string | undefined;
		caption: string | undefined;
	},
): Promise<ToolResult> {
	const { filename, mimeType, dataBase64, alt, caption } = input;
	const uploaded = await callTenantMcpTool(ctx, "media_upload", {
		filename,
		base64: dataBase64,
		contentType: mimeType,
		...(alt !== undefined ? { alt } : {}),
	});
	if (uploaded.isError) return uploaded;

	let data = asRecord(unwrapCmsToolResult(uploaded, "CMS native media_upload"));
	if (!data) {
		return tenantMcpError(
			"CMS_MCP_INVALID_RESPONSE",
			"Native media_upload returned a non-JSON result",
		);
	}

	const item = asRecord(data.item);
	const metadataUpdate = {
		...(data.deduplicated === true && alt !== undefined && item?.alt !== alt
			? { alt }
			: {}),
		...(caption !== undefined && item?.caption !== caption ? { caption } : {}),
	};
	if (Object.keys(metadataUpdate).length > 0) {
		const id = typeof item?.id === "string" ? item.id : undefined;
		if (!id) {
			return tenantMcpError(
				"CMS_MCP_INVALID_RESPONSE",
				"Native media_upload returned no media item id for metadata update",
			);
		}
		const updated = await callTenantMcpTool(ctx, "media_update", {
			id,
			...metadataUpdate,
		});
		if (updated.isError) {
			return tenantMcpError(
				"CMS_PARTIAL_FAILURE",
				`Media ${id} ${data.deduplicated === true ? "reused" : "uploaded"} but metadata update failed: ${updated.content[0]?.text ?? "unknown error"}`,
			);
		}
		const updatedItem = asRecord(
			asRecord(unwrapCmsToolResult(updated, "CMS native media_update"))?.item,
		);
		if (
			updatedItem?.id !== id ||
			Object.entries(metadataUpdate).some(
				([field, value]) => updatedItem[field] !== value,
			)
		) {
			return tenantMcpError(
				"CMS_PARTIAL_FAILURE",
				`Media ${id} metadata update returned incomplete readback`,
			);
		}
		data = { ...data, item: updatedItem };
	}

	// Keep the media upload success envelope consistent across MCP and REST.
	return {
		content: [{ type: "text", text: JSON.stringify({ success: true, data }) }],
	};
}

async function mediaUploadViaRestMultipart(
	ctx: CmsProxyContext,
	input: {
		filename: string;
		mimeType: string;
		dataBase64: string;
		alt: string | undefined;
		caption: string | undefined;
	},
): Promise<ToolResult> {
	const { filename, mimeType, dataBase64, alt, caption } = input;
	const authCandidates = buildCmsAuthHeaderCandidates(ctx);
	if (authCandidates.length === 0) return cmsAuthUnavailableToolResult(ctx);

	let bytes: Uint8Array;
	try {
		const binary = atob(dataBase64);
		bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
	} catch {
		return {
			content: [
				{ type: "text", text: "[CMS_ERROR] dataBase64 is not valid base64" },
			],
			isError: true,
		};
	}

	const baseUrl = cmsApiBaseUrl(ctx);
	const doFetch = cmsDoFetch(ctx);

	const formData = new FormData();
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	formData.set("file", new Blob([buffer], { type: mimeType }), filename);

	const result = await executeCmsRestRequest(
		authCandidates,
		doFetch,
		"POST",
		`${baseUrl}/media`,
		formData,
	);
	if (!result.ok) {
		return {
			content: [
				{
					type: "text",
					text: `[CMS_ERROR] Upload failed (${result.status}, auth=${result.authSource}): ${result.text.slice(0, 400)}`,
				},
			],
			isError: true,
		};
	}

	// The REST POST /media route ignores alt/caption form fields, so chain
	// media_update — otherwise both were silently dropped.
	let data = apiData(result.json) ?? {};
	if (alt || caption) {
		const item = asRecord(data.item);
		const id = typeof item?.id === "string" ? item.id : undefined;
		if (id) {
			const update = await executeCmsRestRequest(
				authCandidates,
				doFetch,
				"PUT",
				`${baseUrl}/media/${encodeURIComponent(id)}`,
				{ ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) },
			);
			if (!update.ok) {
				return tenantMcpError(
					"CMS_PARTIAL_FAILURE",
					`Media ${id} uploaded but alt/caption update failed (${update.status}, auth=${update.authSource}): ${update.text.slice(0, 400)}`,
				);
			}
			const updatedItem = asRecord(apiData(update.json)?.item);
			if (updatedItem) data = { ...data, item: updatedItem };
		}
	}

	return {
		content: [{ type: "text", text: JSON.stringify({ success: true, data }) }],
	};
}

// ---------------------------------------------------------------------------
// media_to_field_value — pure transform: produce a MediaValue ready to drop
// into content_update.data.{field}. Two modes:
//   - mediaId: looks up the local media item via media_get and shapes the
//     MediaValue with provider="local"
//   - providerId+providerItemId: external provider reference, no DB lookup
// ---------------------------------------------------------------------------

export async function mediaToFieldValue(
	ctx: CmsProxyContext,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const mediaId = args.mediaId as string | undefined;
	const providerId = args.providerId as string | undefined;
	const providerItemId = args.providerItemId as string | undefined;

	if (mediaId) {
		const got = await callCmsRest(ctx, "media_get", { id: mediaId });
		if (got.isError) return got;
		try {
			const raw = got.content[0]?.text ?? "{}";
			const parsed = JSON.parse(raw) as unknown;
			const item = asRecord(apiData(parsed)?.item);
			if (!item)
				return {
					content: [{ type: "text", text: "[CMS_ERROR] media item not found" }],
					isError: true,
				};
			const focalX = item.focalX;
			const focalY = item.focalY;
			const hasFocalPoint =
				typeof focalX === "number" &&
				Number.isFinite(focalX) &&
				focalX >= 0 &&
				focalX <= 1 &&
				typeof focalY === "number" &&
				Number.isFinite(focalY) &&
				focalY >= 0 &&
				focalY <= 1;
			const value = {
				provider: "local",
				id: item.id,
				filename: item.filename,
				mimeType: item.mime_type ?? item.mimeType,
				...(typeof item.width === "number" ? { width: item.width } : {}),
				...(typeof item.height === "number" ? { height: item.height } : {}),
				...(hasFocalPoint ? { focalX, focalY } : {}),
				...(typeof item.blurhash === "string"
					? { blurhash: item.blurhash }
					: {}),
				...(typeof item.dominantColor === "string"
					? { dominantColor: item.dominantColor }
					: {}),
				alt: item.alt ?? undefined,
				caption: item.caption ?? undefined,
				meta: { storageKey: item.storage_key ?? item.storageKey },
			};
			return {
				content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
				structuredContent: value,
			} as ToolResult;
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `[CMS_ERROR] reshape failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	}

	if (providerId && providerItemId) {
		const value = {
			provider: providerId,
			id: providerItemId,
			src: args.previewUrl ?? undefined,
			filename: args.filename ?? undefined,
			mimeType: args.mimeType ?? undefined,
			width: args.width ?? undefined,
			height: args.height ?? undefined,
			alt: args.alt ?? undefined,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
			structuredContent: value,
		} as ToolResult;
	}

	return {
		content: [
			{
				type: "text",
				text: "[CMS_ERROR] either mediaId OR (providerId + providerItemId) is required",
			},
		],
		isError: true,
	};
}
