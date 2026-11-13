import { z } from "zod";
import { getManagementClient } from "@tedix/auth/client";
import { fetchTenantConnectionTokenByScopes } from "@tedix/auth/connections";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import {
	OsWorkspaceDriveFileSchema,
	type OsWorkspaceDriveRead,
} from "@tedix/api-contract/schemas/os-workspaces";
import { resolveWorkspacePersonalReadCredential } from "./os-workspace-resource-read-authority";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

const FILE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS =
	"id,name,mimeType,modifiedTime,version,parents,trashed,exportLinks";
const metadataSchema = OsWorkspaceDriveFileSchema.extend({
	modifiedTime: z.string().nullable().default(null),
	version: z.string().nullable().default(null),
	parents: z.array(z.string()).default([]),
	trashed: z.boolean().default(false),
	exportLinks: z.record(z.string(), z.string()).default({}),
});
type Metadata = z.infer<typeof metadataSchema>;
type BoundInput = {
	resource: OsWorkspaceResourceRow;
	requiredScopes: string[];
};
type Dependencies = {
	resolveToken?: () => Promise<string | null>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							createError(
								ErrorCodes.BAD_GATEWAY,
								"Google Drive request timed out",
							),
						),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function driveClient(
	context: BaseContext,
	input: BoundInput,
	deps: Dependencies,
) {
	if (!FILE_ID.test(input.resource.providerResourceId))
		throw createError(ErrorCodes.BAD_REQUEST, "Invalid bound Drive object ID");
	if (input.resource.providerAccess?.canRead === false)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Workspace resource does not allow reads",
		);
	const scopes = input.requiredScopes.length
		? input.requiredScopes
		: ["https://www.googleapis.com/auth/drive.readonly"];
	let token: string | null;
	if (deps.resolveToken) token = await deps.resolveToken();
	else if (input.resource.connectionScope === "user")
		token = await resolveWorkspacePersonalReadCredential(
			context,
			input.resource,
			scopes,
		);
	else {
		const tenant = await getOrganizationDescopeTenantId(
			context.db,
			input.resource.organizationId,
		);
		token = tenant
			? ((
					await fetchTenantConnectionTokenByScopes(
						getManagementClient(context.env),
						input.resource.providerId,
						tenant,
						scopes,
					)
				)?.accessToken ?? null)
			: null;
	}
	if (!token)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"No scoped Google Drive connection is available",
		);
	const timeoutMs = deps.timeoutMs ?? 15000;
	const request = async (
		path: string,
		params: Record<string, string>,
		headers: Record<string, string> = {},
	) => {
		const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
		for (const [key, value] of Object.entries(params))
			url.searchParams.set(key, value);
		const response = await deadline(
			(deps.fetchImpl ?? fetch)(url.href, {
				headers: { Authorization: `Bearer ${token}`, ...headers },
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "error",
			}),
			timeoutMs,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw createError(
				response.status === 404
					? ErrorCodes.NOT_FOUND
					: response.status === 401 || response.status === 403
						? ErrorCodes.FORBIDDEN
						: response.status === 416
							? ErrorCodes.BAD_REQUEST
							: ErrorCodes.BAD_GATEWAY,
				`Google Drive read failed (HTTP ${response.status})`,
			);
		}
		return response;
	};
	const metadata = async (fileId: string) => {
		const response = await request(`files/${fileId}`, {
			fields: FIELDS,
			supportsAllDrives: "true",
		});
		const parsed = metadataSchema.safeParse(
			await deadline(response.json(), timeoutMs),
		);
		if (!parsed.success || parsed.data.id !== fileId || parsed.data.trashed)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Readable Drive object not found",
			);
		return parsed.data;
	};
	return { request, metadata, timeoutMs };
}

function fileSummary(file: Metadata) {
	return OsWorkspaceDriveFileSchema.parse(file);
}

export async function listWorkspaceDriveFiles(
	context: BaseContext,
	input: BoundInput & { pageToken?: string; limit: number },
	deps: Dependencies = {},
) {
	if (input.resource.resourceType !== "folder")
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A connected Drive folder is required",
		);
	const client = await driveClient(context, input, deps);
	const folder = await client.metadata(input.resource.providerResourceId);
	if (folder.mimeType !== FOLDER)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The bound Drive object is not a folder",
		);
	const response = await client.request("files", {
		q: `'${folder.id}' in parents and trashed = false`,
		pageSize: String(input.limit),
		fields: `files(${FIELDS}),nextPageToken,incompleteSearch`,
		supportsAllDrives: "true",
		includeItemsFromAllDrives: "true",
		...(input.pageToken ? { pageToken: input.pageToken } : {}),
	});
	const result = z
		.object({
			files: z.array(metadataSchema).max(50),
			nextPageToken: z.string().max(2048).optional(),
			incompleteSearch: z.boolean().optional(),
		})
		.parse(await deadline(response.json(), client.timeoutMs));
	if (result.incompleteSearch)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Google Drive returned an incomplete folder search",
		);
	if (
		result.files.some(
			(file) => file.trashed || !file.parents.includes(folder.id),
		)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Google Drive listing escaped the connected folder",
		);
	return {
		items: result.files.map(fileSummary),
		nextPageToken: result.nextPageToken ?? null,
	};
}

function checkBoundFile(resource: OsWorkspaceResourceRow, file: Metadata) {
	if (
		resource.resourceType === "folder"
			? !file.parents.includes(resource.providerResourceId)
			: file.id !== resource.providerResourceId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"File is outside the connected Drive resource",
		);
	if (file.mimeType === FOLDER)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Choose a file directly inside the connected folder",
		);
}

/** Exports cannot use HTTP ranges; skip their prefix while keeping only one window in memory. */
async function readWindow(
	response: Response,
	offset: number,
	limit: number,
	timeoutMs: number,
) {
	if (!response.body)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Google Drive returned no file body",
		);
	const reader = response.body.getReader();
	const bytes = new Uint8Array(limit + 1);
	let seen = 0,
		count = 0;
	try {
		while (count < bytes.length) {
			const { done, value } = await deadline(reader.read(), timeoutMs);
			if (done) break;
			const start = Math.max(0, offset - seen);
			const take = Math.min(
				Math.max(0, value.length - start),
				bytes.length - count,
			);
			if (take) bytes.set(value.subarray(start, start + take), count);
			count += take;
			seen += value.length;
		}
	} finally {
		// Do not let a provider's cancellation handshake stall the read result.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return {
		bytes: bytes.subarray(0, Math.min(count, limit)),
		more: count > limit,
	};
}

export async function readWorkspaceDriveFile(
	context: BaseContext,
	input: BoundInput & {
		fileId?: string;
		byteOffset: number;
		byteLimit: number;
		expectedVersion?: string;
		exportMimeType?: string;
	},
	deps: Dependencies = {},
): Promise<OsWorkspaceDriveRead> {
	const fileId = input.fileId ?? input.resource.providerResourceId;
	if (!FILE_ID.test(fileId))
		throw createError(ErrorCodes.BAD_REQUEST, "Invalid Drive file ID");
	if (
		input.resource.resourceType !== "folder" &&
		fileId !== input.resource.providerResourceId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"File is outside the connected Drive resource",
		);
	const client = await driveClient(context, input, deps);
	if (
		input.resource.resourceType === "folder" &&
		(await client.metadata(input.resource.providerResourceId)).mimeType !==
			FOLDER
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The bound Drive object is not a folder",
		);
	const file = await client.metadata(fileId);
	checkBoundFile(input.resource, file);
	if (input.expectedVersion && input.expectedVersion !== file.version)
		throw createError(
			ErrorCodes.CONFLICT,
			"Google Drive file changed; restart the ranged read",
		);
	const native = file.mimeType.startsWith("application/vnd.google-apps.");
	let contentMimeType = file.mimeType;
	let response: Response;
	if (native) {
		// Google caps synchronous exports at 10 MB; never follow provider-supplied URLs.
		if (input.byteOffset > 10 * 1024 * 1024)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Export offset exceeds the 10 MB export limit",
			);
		contentMimeType =
			input.exportMimeType ??
			["text/plain", "text/csv", "application/pdf"].find((type) =>
				Object.hasOwn(file.exportLinks, type),
			) ??
			Object.keys(file.exportLinks)[0] ??
			"";
		if (!contentMimeType || !Object.hasOwn(file.exportLinks, contentMimeType))
			throw createError(
				ErrorCodes.UNPROCESSABLE_CONTENT,
				"Drive file has no supported export; choose an available export MIME type",
			);
		response = await client.request(`files/${fileId}/export`, {
			mimeType: contentMimeType,
		});
	} else {
		response = await client.request(
			`files/${fileId}`,
			{ alt: "media", supportsAllDrives: "true" },
			{
				Range: `bytes=${input.byteOffset}-${input.byteOffset + input.byteLimit}`,
			},
		);
		if (response.status === 206) {
			const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
				response.headers.get("content-range") ?? "",
			);
			if (
				!range ||
				Number(range[1]) !== input.byteOffset ||
				Number(range[2]) > input.byteOffset + input.byteLimit ||
				Number(range[2]) < Number(range[1])
			) {
				await response.body?.cancel();
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					"Google Drive returned an invalid byte range",
				);
			}
		} else if (input.byteOffset !== 0) {
			await response.body?.cancel();
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Google Drive ignored the requested byte range",
			);
		}
	}
	const window = await readWindow(
		response,
		native ? input.byteOffset : 0,
		input.byteLimit,
		client.timeoutMs,
	);
	const checked = await client.metadata(fileId);
	checkBoundFile(input.resource, checked);
	if (
		checked.version !== file.version ||
		checked.modifiedTime !== file.modifiedTime
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Google Drive file changed during the read",
		);
	return {
		resourceId: input.resource.id,
		file: fileSummary(file),
		contentMimeType,
		encoding: "base64",
		data: btoa(String.fromCharCode(...window.bytes)),
		byteOffset: input.byteOffset,
		byteLength: window.bytes.length,
		nextByteOffset: window.more ? input.byteOffset + window.bytes.length : null,
	};
}
