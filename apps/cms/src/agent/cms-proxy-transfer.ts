import { createHash } from "node:crypto";
import { getCmsTemplateSelection } from "./storage";
import {
	cmsApiBaseUrl,
	buildCmsAuthHeaderCandidates,
	type CmsProxyContext,
	type ToolResult,
} from "./cms-proxy-runtime";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGE_FILES = 2;
const slugPattern = /^[a-z][a-z0-9-]{0,62}$/;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/;
const filePathPattern =
	/^(?:index\/[0-9]{6}\.ndjson|records\/(?:principal|block_type|block_type_version|collection|field|taxonomy_def|relation|byline_field|media_folder|media|term|byline|byline_field_value|byline_field_group_value|revision|entry|content_term|content_byline|content_reference|seo|menu|menu_item|widget_area|widget|section|redirect|comment|comment_reaction|setting)\/[0-9]{6}\.ndjson|media\/[0-9a-f]{64})$/;
const shaPattern = /^[0-9a-f]{64}$/;

type TransferArgs = {
	sourceSlug: string;
	targetSlug: string;
	exportOperationId: string;
	importOperationId?: string;
	limit?: number;
	cursor?: string;
};

type Access = {
	source: CmsProxyContext;
	target: CmsProxyContext;
};

function result(value: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function failure(code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${code}] ${message}` }],
		isError: true,
	};
}
function requireOperationId(value: string): void {
	if (!operationPattern.test(value)) throw new Error("Invalid operation ID");
}
function requireFile(
	value: unknown,
): asserts value is { path: string; bytes: number; sha256: string } {
	if (!value || typeof value !== "object")
		throw new Error("Invalid file declaration");
	const file = value as Record<string, unknown>;
	if (
		typeof file.path !== "string" ||
		!filePathPattern.test(file.path) ||
		typeof file.bytes !== "number" ||
		!Number.isSafeInteger(file.bytes) ||
		file.bytes < 0 ||
		file.bytes > MAX_FILE_BYTES ||
		typeof file.sha256 !== "string" ||
		!shaPattern.test(file.sha256) ||
		(file.path.startsWith("media/") && file.path.slice(6) !== file.sha256)
	)
		throw new Error("Invalid or oversized file declaration");
}
async function authorized(
	ctx: CmsProxyContext,
	args: TransferArgs,
): Promise<Access> {
	if (!ctx.isPlatformAdmin)
		throw new Error(
			"Platform admin required for site transfer. The calling credential must carry platform:admin or a platform-admin role; ordinary MCP admin scopes do not qualify. Eligible humans can use tedix login --scope-profile platform-admin and explicitly approve Platform administration. Tedis require an existing platform_admin capability profile through trusted delegation.",
		);
	if (!ctx.db || !ctx.cmsDispatch) {
		throw new Error(
			"Transfer bridge requires platform storage and CMS_DISPATCH",
		);
	}
	if (
		!slugPattern.test(args.sourceSlug) ||
		!slugPattern.test(args.targetSlug) ||
		args.sourceSlug === args.targetSlug
	) {
		throw new Error("Distinct valid source and target slugs required");
	}
	requireOperationId(args.exportOperationId);
	if (args.importOperationId) requireOperationId(args.importOperationId);
	const [source, target] = await Promise.all([
		getCmsTemplateSelection(ctx.db, args.sourceSlug),
		getCmsTemplateSelection(ctx.db, args.targetSlug),
	]);
	if (!source || !target || source.organizationId !== target.organizationId) {
		throw new Error(
			"Source and target must be active sites owned by the same organization",
		);
	}
	if (ctx.humanAuthRequired) {
		if (
			!ctx.humanIdentity ||
			!ctx.internalAuthToken ||
			!ctx.loadTransferHumanIdentity
		)
			throw new Error("Verified human transfer identities required");
		const [sourceIdentity, targetIdentity] = await Promise.all([
			ctx.loadTransferHumanIdentity(args.sourceSlug),
			ctx.loadTransferHumanIdentity(args.targetSlug),
		]);
		if (
			!sourceIdentity ||
			!targetIdentity ||
			sourceIdentity.slug !== args.sourceSlug ||
			targetIdentity.slug !== args.targetSlug ||
			sourceIdentity.subject !== ctx.humanIdentity.subject ||
			targetIdentity.subject !== ctx.humanIdentity.subject
		)
			throw new Error("Verified human transfer identities required");
		return {
			source: {
				...ctx,
				orgSlug: args.sourceSlug,
				humanIdentity: sourceIdentity,
				serviceApiKey: undefined,
			},
			target: {
				...ctx,
				orgSlug: args.targetSlug,
				humanIdentity: targetIdentity,
				serviceApiKey: undefined,
			},
		};
	}
	if (!ctx.loadTransferServiceKey)
		throw new Error("Source and target Emdash service PATs required");
	const [sourceKey, targetKey] = await Promise.all([
		ctx.loadTransferServiceKey(args.sourceSlug),
		ctx.loadTransferServiceKey(args.targetSlug),
	]);
	if (!sourceKey?.startsWith("ec_pat_") || !targetKey?.startsWith("ec_pat_")) {
		throw new Error("Source and target Emdash service PATs required");
	}
	return {
		source: { ...ctx, orgSlug: args.sourceSlug, serviceApiKey: sourceKey },
		target: { ...ctx, orgSlug: args.targetSlug, serviceApiKey: targetKey },
	};
}

function transferAuthHeaders(ctx: CmsProxyContext): Record<string, string> {
	if (ctx.humanAuthRequired) {
		const candidate = buildCmsAuthHeaderCandidates(ctx)[0];
		if (!candidate)
			throw new Error("Verified human transfer identities required");
		return candidate.headers;
	}
	return { Authorization: `Bearer ${ctx.serviceApiKey}` };
}

async function request(
	ctx: CmsProxyContext,
	method: string,
	path: string,
	body?: Uint8Array<ArrayBuffer>,
	idempotencyKey?: string,
): Promise<Response> {
	const response = await ctx.cmsDispatch!.fetch(
		new Request(`${cmsApiBaseUrl(ctx)}/admin/transfer/${path}`, {
			method,
			headers: {
				...transferAuthHeaders(ctx),
				Accept: "application/json",
				...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
				...(body
					? {
							"Content-Type":
								path === "imports"
									? "application/json"
									: "application/octet-stream",
							"Content-Length": String(body.byteLength),
						}
					: {}),
			},
			body: body?.buffer,
		}),
	);
	if (!response.ok)
		throw new Error(`Emdash transfer request failed (${response.status})`);
	return response;
}
async function jsonData(
	ctx: CmsProxyContext,
	method: string,
	path: string,
	body?: Uint8Array<ArrayBuffer>,
	idempotencyKey?: string,
): Promise<Record<string, unknown>> {
	const response = await request(ctx, method, path, body, idempotencyKey);
	return responseData(response);
}
async function responseData(
	response: Response,
): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	if (
		!value ||
		typeof value !== "object" ||
		!("data" in value) ||
		!value.data ||
		typeof value.data !== "object"
	) {
		throw new Error("Invalid Emdash transfer response");
	}
	return value.data as Record<string, unknown>;
}
async function uploadFile(
	ctx: CmsProxyContext,
	path: string,
	source: Response,
	expected: { bytes: number; sha256: string },
): Promise<Record<string, unknown>> {
	const verified = verifiedFileStream(source, expected);
	const response = await ctx.cmsDispatch!.fetch(
		new Request(`${cmsApiBaseUrl(ctx)}/admin/transfer/${path}`, {
			method: "PUT",
			headers: {
				...transferAuthHeaders(ctx),
				Accept: "application/json",
				"Content-Type": "application/octet-stream",
				"Content-Length": String(expected.bytes),
			},
			body: verified.body,
			duplex: "half",
		} as RequestInit & { duplex: "half" }),
	);
	if (!response.ok)
		throw new Error(`Emdash transfer request failed (${response.status})`);
	verified.assertVerified();
	return responseData(response);
}
async function boundedBytes(
	response: Response,
	max: number,
	expected?: { bytes: number; sha256: string },
): Promise<Uint8Array<ArrayBuffer>> {
	const { length, body } = fileResponse(response, max, expected);
	const reader = body.getReader();
	const bytes = new Uint8Array(length);
	const hasher = createHash("sha256");
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > length) throw new Error("File exceeded declared size");
			bytes.set(value, total - value.byteLength);
			hasher.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (total !== length) throw new Error("File truncated");
	if (hasher.digest("hex") !== response.headers.get("ETag")!.slice(1, -1))
		throw new Error("File SHA-256 mismatch");
	return bytes;
}
function fileResponse(
	response: Response,
	max: number,
	expected?: { bytes: number; sha256: string },
): { length: number; body: ReadableStream<Uint8Array> } {
	const declared = response.headers.get("Content-Length");
	const etag = response.headers.get("ETag");
	if (
		!declared ||
		!/^(0|[1-9][0-9]*)$/.test(declared) ||
		!etag ||
		!/^"[0-9a-f]{64}"$/.test(etag)
	) {
		throw new Error("Missing or invalid file integrity headers");
	}
	const length = Number(declared);
	if (
		!Number.isSafeInteger(length) ||
		length > max ||
		(expected && length !== expected.bytes)
	) {
		throw new Error("File size mismatch or limit exceeded");
	}
	if (expected && etag.slice(1, -1) !== expected.sha256)
		throw new Error("File ETag mismatch");
	if (!response.body) throw new Error("Empty file response");
	return { length, body: response.body };
}
function verifiedFileStream(
	response: Response,
	expected: { bytes: number; sha256: string },
): { body: ReadableStream<Uint8Array>; assertVerified: () => void } {
	const { length, body } = fileResponse(response, MAX_FILE_BYTES, expected);
	const hasher = createHash("sha256");
	let total = 0;
	let verified = false;
	return {
		body: body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					total += chunk.byteLength;
					if (total > length) throw new Error("File exceeded declared size");
					hasher.update(chunk);
					controller.enqueue(chunk);
				},
				flush() {
					if (total !== length) throw new Error("File truncated");
					if (hasher.digest("hex") !== expected.sha256)
						throw new Error("File SHA-256 mismatch");
					verified = true;
				},
			}),
		),
		assertVerified() {
			if (!verified) throw new Error("Upload stream was not fully verified");
		},
	};
}
async function manifest(
	access: Access,
	id: string,
): Promise<{
	bytes: Uint8Array<ArrayBuffer>;
	sha256: string;
	files: number;
	index: Array<{ path: string; bytes: number; sha256: string }>;
}> {
	const status = await jsonData(access.source, "GET", `exports/${id}`);
	const operation = status.operation as Record<string, unknown> | undefined;
	if (
		operation?.state !== "complete" ||
		typeof operation.packageDigest !== "string"
	)
		throw new Error("Source export is not complete");
	const response = await request(
		access.source,
		"GET",
		`exports/${id}/manifest`,
	);
	const bytes = await boundedBytes(response, MAX_MANIFEST_BYTES);
	const raw: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes),
	);
	if (!raw || typeof raw !== "object")
		throw new Error("Invalid export manifest");
	const data = raw as Record<string, unknown>;
	const files = data.files as Record<string, unknown> | undefined;
	if (
		data.format !== "emdash-site-package" ||
		data.formatVersion !== "1" ||
		data.profile !== "full-transfer" ||
		!files ||
		!Number.isSafeInteger(files.count) ||
		(files.count as number) < 0 ||
		(files.count as number) > 1_000_000 ||
		!Number.isSafeInteger(files.totalBytes) ||
		(files.totalBytes as number) < 0 ||
		!Array.isArray(data.index) ||
		data.index.length > 1000
	) {
		throw new Error("Invalid export manifest file index");
	}
	const index = data.index as Array<{
		path: string;
		bytes: number;
		sha256: string;
		entries: number;
	}>;
	let entries = 0;
	for (const [sequence, entry] of index.entries()) {
		requireFile(entry);
		if (
			entry.path !== `index/${String(sequence).padStart(6, "0")}.ndjson` ||
			entry.bytes > 4 * 1024 * 1024 ||
			!Number.isSafeInteger(entry.entries) ||
			entry.entries < 0 ||
			entry.entries > 1000
		)
			throw new Error("Invalid export manifest file index");
		entries += entry.entries;
	}
	if (entries !== files.count)
		throw new Error("Invalid export manifest file index");
	return {
		bytes,
		sha256: response.headers.get("ETag")!.slice(1, -1),
		files: files.count as number,
		index,
	};
}
function importIdempotencyKey(
	args: TransferArgs,
	manifestSha256: string,
): string {
	return `tedix-${createHash("sha256")
		.update(
			`${args.sourceSlug}\0${args.targetSlug}\0${args.exportOperationId}\0${manifestSha256}`,
		)
		.digest("hex")}`;
}
function safeError(error: unknown): ToolResult {
	// Do not forward upstream bodies or exception text that could include credentials or bytes.
	const message =
		error instanceof Error ? error.message : "Transfer bridge failed";
	const safe =
		new Set([
			"Platform admin required for site transfer. The calling credential must carry platform:admin or a platform-admin role; ordinary MCP admin scopes do not qualify. Eligible humans can use tedix login --scope-profile platform-admin and explicitly approve Platform administration. Tedis require an existing platform_admin capability profile through trusted delegation.",
			"Transfer bridge requires platform storage and CMS_DISPATCH",
			"Distinct valid source and target slugs required",
			"Invalid operation ID",
			"Invalid file declaration",
			"Invalid or oversized file declaration",
			"Source and target must be active sites owned by the same organization",
			"Source and target Emdash service PATs required",
			"Verified human transfer identities required",
			"Invalid Emdash transfer response",
			"Missing or invalid file integrity headers",
			"File size mismatch or limit exceeded",
			"File ETag mismatch",
			"Empty file response",
			"File exceeded declared size",
			"File truncated",
			"File SHA-256 mismatch",
			"Source export is not complete",
			"Invalid export manifest",
			"Invalid export manifest file index",
			"Invalid import operation response",
			"Target import does not match source export or is past upload phase",
			"Invalid page limit",
			"Invalid cursor",
			"Invalid missing-file page",
			"Upload confirmation mismatch",
		]).has(message) ||
		/^Emdash transfer request failed \([1-5][0-9]{2}\)$/.test(message);
	return failure(
		"TRANSFER_BRIDGE_ERROR",
		safe ? message : "Transfer bridge failed",
	);
}
export async function prepareSiteTransferExport(
	ctx: CmsProxyContext,
	args: TransferArgs,
): Promise<ToolResult> {
	try {
		const access = await authorized(ctx, args);
		const data = await manifest(access, args.exportOperationId);
		return result({
			sourceSlug: args.sourceSlug,
			targetSlug: args.targetSlug,
			exportOperationId: args.exportOperationId,
			manifestBytes: data.bytes.byteLength,
			manifestSha256: data.sha256,
			files: data.files,
		});
	} catch (error) {
		return safeError(error);
	}
}
export async function createSiteTransferImport(
	ctx: CmsProxyContext,
	args: TransferArgs,
): Promise<ToolResult> {
	let importId = args.importOperationId;
	try {
		const access = await authorized(ctx, args);
		const sourceManifest = await manifest(access, args.exportOperationId);
		let created = false;
		if (!importId) {
			const createdData = await jsonData(
				access.target,
				"POST",
				"imports",
				sourceManifest.bytes,
				importIdempotencyKey(args, sourceManifest.sha256),
			);
			const operation = createdData.operation as
				| Record<string, unknown>
				| undefined;
			if (
				typeof operation?.id !== "string" ||
				!operationPattern.test(operation.id)
			)
				throw new Error("Invalid import operation response");
			importId = operation.id;
			created = createdData.created === true;
		}
		const importStatus = await jsonData(
			access.target,
			"GET",
			`imports/${importId}`,
		);
		const targetOperation = importStatus.operation as
			| Record<string, unknown>
			| undefined;
		const sourceStatus = await jsonData(
			access.source,
			"GET",
			`exports/${args.exportOperationId}`,
		);
		const sourceOperation = sourceStatus.operation as
			| Record<string, unknown>
			| undefined;
		if (
			targetOperation?.state !== "uploading" ||
			targetOperation.packageDigest !== sourceOperation?.packageDigest
		) {
			throw new Error(
				"Target import does not match source export or is past upload phase",
			);
		}
		const limit = Math.min(args.limit ?? MAX_PAGE_FILES, MAX_PAGE_FILES);
		if (!Number.isInteger(limit) || limit < 1)
			throw new Error("Invalid page limit");
		if (args.cursor && args.cursor.length > 2048)
			throw new Error("Invalid cursor");
		const query = new URLSearchParams({ limit: String(limit) });
		if (args.cursor) query.set("cursor", args.cursor);
		const missing = await jsonData(
			access.target,
			"GET",
			`imports/${importId}/missing?${query}`,
		);
		if (!Array.isArray(missing.items) || missing.items.length > limit)
			throw new Error("Invalid missing-file page");
		const copied: string[] = [];
		for (const entry of missing.items) {
			requireFile(entry);
			if (
				entry.path.startsWith("index/") &&
				!sourceManifest.index.some(
					(ref) =>
						ref.path === entry.path &&
						ref.bytes === entry.bytes &&
						ref.sha256 === entry.sha256,
				)
			)
				throw new Error("Invalid missing-file page");
			const source = await request(
				access.source,
				"GET",
				`exports/${args.exportOperationId}/files/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
			);
			const upload = await uploadFile(
				access.target,
				`imports/${importId}/files/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
				source,
				entry,
			);
			if (upload.path !== entry.path || upload.bytes !== entry.bytes)
				throw new Error("Upload confirmation mismatch");
			copied.push(entry.path);
		}
		return result({
			sourceSlug: args.sourceSlug,
			targetSlug: args.targetSlug,
			exportOperationId: args.exportOperationId,
			importOperationId: importId,
			created,
			copied,
			nextCursor: missing.nextCursor ?? null,
			phase: "uploading",
		});
	} catch (error) {
		const response = safeError(error);
		if (importId && operationPattern.test(importId)) {
			response.content[0]!.text += `; importOperationId=${importId}`;
		}
		return response;
	}
}
