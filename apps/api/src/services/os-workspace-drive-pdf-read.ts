import { getManagementClient } from "@tedix/auth/client";
import {
	fetchConnectionTokenByScopes,
	fetchTenantConnectionTokenByScopes,
} from "@tedix/auth/connections";
import type { OsWorkspacePdfRead } from "@tedix/api-contract/schemas/os-workspaces";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { BaseContext } from "../rpc/orpc";
import { createError, ErrorCodes } from "../rpc/orpc";
import { splitConvertedPdf } from "../workflows/content-ingestion-pdf";

const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const PDF_MAX_BYTES = 2 * 1024 * 1024;
// Two pages plus metadata stay below Code Mode's 24,000-character result cap.
const PAGE_MAX_CHARS = 7_000;
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{1,255}$/;

type DriveFileMetadata = {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string | null;
	version: string | null;
};

type ReadDependencies = {
	resolveToken?: () => Promise<string | null>;
	fetchImpl?: typeof fetch;
	ai?: Pick<Ai, "toMarkdown">;
};

function metadataUrl(fileId: string): string {
	const url = new URL(
		`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
	);
	url.searchParams.set("fields", "id,name,mimeType,modifiedTime,version");
	url.searchParams.set("supportsAllDrives", "true");
	return url.href;
}

function mediaUrl(fileId: string): string {
	const url = new URL(
		`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
	);
	url.searchParams.set("alt", "media");
	url.searchParams.set("supportsAllDrives", "true");
	return url.href;
}

function driveReadError(status: number): Error {
	if (status === 401 || status === 403) {
		return createError(
			ErrorCodes.FORBIDDEN,
			"The Google Drive connection cannot read this PDF. Reconnect a Drive REST-capable credential with file access.",
		);
	}
	if (status === 404) {
		return createError(ErrorCodes.NOT_FOUND, "Google Drive PDF not found");
	}
	return createError(
		ErrorCodes.BAD_GATEWAY,
		`Google Drive read failed (HTTP ${status})`,
	);
}

async function readMetadata(
	fetchImpl: typeof fetch,
	fileId: string,
	token: string,
): Promise<DriveFileMetadata> {
	const response = await fetchImpl(metadataUrl(fileId), {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	if (!response.ok) throw driveReadError(response.status);
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Google Drive returned invalid file metadata",
		);
	}
	const file = value as Record<string, unknown>;
	if (
		file.id !== fileId ||
		typeof file.name !== "string" ||
		file.mimeType !== "application/pdf"
	) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"The bound Google Drive object is not a PDF file",
		);
	}
	return {
		id: fileId,
		name: file.name.slice(0, 500),
		mimeType: "application/pdf",
		modifiedTime:
			typeof file.modifiedTime === "string" ? file.modifiedTime : null,
		version: typeof file.version === "string" ? file.version : null,
	};
}

async function readBoundedPdf(
	response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (contentLength > PDF_MAX_BYTES) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"PDF exceeds the 2 MB read limit",
		);
	}
	if (!response.body) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Google Drive returned an empty PDF body",
		);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > PDF_MAX_BYTES) {
				await reader.cancel();
				throw createError(
					ErrorCodes.UNPROCESSABLE_CONTENT,
					"PDF exceeds the 2 MB read limit",
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (
		bytes.byteLength < 5 ||
		new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
	) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Google Drive did not return PDF bytes",
		);
	}
	return bytes;
}

export function splitPdfPages(
	markdown: string,
): Array<{ page: number; text: string }> {
	const matches = [...markdown.matchAll(/^### Page (\d+)\s*$/gm)];
	if (matches.length === 0) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"PDF conversion returned no verifiable page boundaries",
		);
	}
	return matches.map((match, index) => {
		const page = Number(match[1]);
		if (!Number.isSafeInteger(page) || page !== index + 1) {
			throw createError(
				ErrorCodes.UNPROCESSABLE_CONTENT,
				"PDF conversion returned invalid page boundaries",
			);
		}
		const next = matches[index + 1];
		return {
			page,
			text: markdown
				.slice(match.index! + match[0].length, next?.index ?? markdown.length)
				.trim(),
		};
	});
}

async function resolveDriveToken(
	context: BaseContext,
	resource: OsWorkspaceResourceRow,
	requiredScopes: string[],
): Promise<string | null> {
	const tenantId = await getOrganizationDescopeTenantId(
		context.db,
		resource.organizationId,
	);
	if (!tenantId) return null;
	const client = getManagementClient(context.env);
	const scopes =
		requiredScopes.length > 0 ? requiredScopes : [DRIVE_READ_SCOPE];
	const token =
		resource.connectionScope === "tenant"
			? await fetchTenantConnectionTokenByScopes(
					client,
					resource.providerId,
					tenantId,
					scopes,
				)
			: await fetchConnectionTokenByScopes(
					client,
					resource.providerId,
					context.descopeUserId ?? context.user?.sub ?? "",
					scopes,
					tenantId,
				);
	return token?.accessToken ?? null;
}

/** Live provider read. No PDF bytes, token, or extracted text are persisted. */
export async function readWorkspaceDrivePdf(
	context: BaseContext,
	input: {
		resource: OsWorkspaceResourceRow;
		requiredScopes: string[];
		pageStart: number;
		pageLimit: number;
		charOffset: number;
	},
	dependencies: ReadDependencies = {},
): Promise<OsWorkspacePdfRead> {
	if (!DRIVE_FILE_ID.test(input.resource.providerResourceId)) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The bound Google Drive file ID is invalid",
		);
	}
	const token = dependencies.resolveToken
		? await dependencies.resolveToken()
		: await resolveDriveToken(context, input.resource, input.requiredScopes);
	if (!token) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"No scoped Google Drive connection is available for this PDF",
		);
	}
	const fetchImpl = dependencies.fetchImpl ?? fetch;
	const metadata = await readMetadata(
		fetchImpl,
		input.resource.providerResourceId,
		token,
	);
	const response = await fetchImpl(mediaUrl(metadata.id), {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" },
	});
	if (!response.ok) throw driveReadError(response.status);
	const bytes = await readBoundedPdf(response);
	const checkedMetadata = await readMetadata(
		fetchImpl,
		input.resource.providerResourceId,
		token,
	);
	if (
		checkedMetadata.version !== metadata.version ||
		checkedMetadata.modifiedTime !== metadata.modifiedTime
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Google Drive PDF changed during the read; retry for one consistent revision",
		);
	}
	const ai = dependencies.ai ?? context.env.AI;
	if (!ai)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"PDF text conversion is unavailable",
		);
	const converted = await ai.toMarkdown({
		name: metadata.name,
		blob: new Blob([bytes], { type: "application/pdf" }),
	});
	if (converted.format === "error") {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"PDF text conversion failed",
		);
	}
	const { body } = splitConvertedPdf(converted.data, metadata.name);
	const allPages = splitPdfPages(body);
	const pages = allPages
		.filter((page) => page.page >= input.pageStart)
		.slice(0, input.pageLimit)
		.map((page) => {
			const text = page.text.slice(
				input.charOffset,
				input.charOffset + PAGE_MAX_CHARS,
			);
			const nextCharOffset =
				input.charOffset + text.length < page.text.length
					? input.charOffset + text.length
					: null;
			return {
				page: page.page,
				text,
				truncated: nextCharOffset !== null,
				nextCharOffset,
			};
		});
	return {
		resourceId: input.resource.id,
		providerResourceId: metadata.id,
		fileName: metadata.name,
		mimeType: "application/pdf",
		modifiedTime: metadata.modifiedTime,
		version: metadata.version,
		sha256: await sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		totalPages: allPages.length,
		pages,
		hasMorePages: allPages.some(
			(page) => page.page >= input.pageStart + input.pageLimit,
		),
	};
}
