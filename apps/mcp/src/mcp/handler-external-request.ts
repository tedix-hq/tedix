import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	readToolConfigExtension,
	readToolConfigStringArray,
} from "./tool-config-extensions";
import type { PDFDocument as PdfDocument } from "pdf-lib";

export class ExternalRequestInputError extends Error {
	override name = "ExternalRequestInputError";
}

export function expandExternalBodyTemplate(
	template: unknown,
	params: Record<string, unknown>,
): unknown {
	if (typeof template === "string") {
		const placeholder = template.match(/^\{([A-Za-z_]\w*)\}$/)?.[1];
		if (!placeholder) return template;
		const value = params[placeholder];
		if (
			value === undefined ||
			value === null ||
			(typeof value !== "string" &&
				typeof value !== "number" &&
				typeof value !== "boolean")
		) {
			throw new ExternalRequestInputError(
				`Missing scalar request-body template value: ${placeholder}`,
			);
		}
		return value;
	}
	if (Array.isArray(template)) {
		return template.map((value) => expandExternalBodyTemplate(value, params));
	}
	if (isRecord(template)) {
		return Object.fromEntries(
			Object.entries(template).map(([key, value]) => [
				key,
				expandExternalBodyTemplate(value, params),
			]),
		);
	}
	return template;
}

function normalizedContentType(contentType: string): string {
	return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

export function setHeaderIfMissing(
	headers: Record<string, string>,
	name: string,
	value: string,
): void {
	if (!hasHeader(headers, name)) headers[name] = value;
}

function appendScalarFormValue(
	append: (value: string) => void,
	value: unknown,
): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) appendScalarFormValue(append, item);
		return;
	}
	if (typeof value === "object") {
		append(JSON.stringify(value));
		return;
	}
	append(String(value));
}

function base64ToBytes(base64: string): Uint8Array {
	const compact = base64.replace(/\s/g, "");
	const binary = atob(compact);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 32_766; // Multiple of 3 so chunked base64 can be concatenated.
	let encoded = "";
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		let binary = "";
		for (let index = 0; index < chunk.length; index++) {
			binary += String.fromCharCode(chunk[index]!);
		}
		encoded += btoa(binary);
	}
	return encoded;
}

export function parseDataUrl(
	value: string,
): { mimeType?: string; base64: string } | null {
	if (!value.startsWith("data:")) return null;
	const commaIndex = value.indexOf(",");
	if (commaIndex === -1) return null;
	const meta = value.slice(5, commaIndex);
	if (!meta.toLowerCase().includes(";base64")) return null;
	const mimeType = meta.split(";")[0] || undefined;
	return { mimeType, base64: value.slice(commaIndex + 1) };
}

function fileParamToBytes(
	paramName: string,
	value: unknown,
): { bytes: Uint8Array; filename: string; mimeType: string } {
	let rawContent: unknown = value;
	let filename = paramName;
	let mimeType = "application/octet-stream";

	if (isRecord(value)) {
		rawContent = value.content ?? value.data ?? value.base64;
		const candidateFilename = value.filename ?? value.name;
		if (typeof candidateFilename === "string" && candidateFilename.trim()) {
			filename = candidateFilename.trim();
		}
		const candidateMimeType = value.mimeType ?? value.type;
		if (typeof candidateMimeType === "string" && candidateMimeType.trim()) {
			mimeType = candidateMimeType.trim();
		}
	}

	if (typeof rawContent !== "string" || rawContent.trim() === "") {
		throw new ExternalRequestInputError(
			`File parameter "${paramName}" must be a data URL, base64 string, or object with content/data/base64.`,
		);
	}

	const dataUrl = parseDataUrl(rawContent.trim());
	const base64 = dataUrl?.base64 ?? rawContent;
	if (dataUrl?.mimeType) mimeType = dataUrl.mimeType;

	try {
		const bytes = base64ToBytes(base64);
		return { bytes, filename, mimeType };
	} catch {
		throw new ExternalRequestInputError(
			`File parameter "${paramName}" is not valid base64 file content.`,
		);
	}
}

export async function fileParamToBlob(
	paramName: string,
	value: unknown,
): Promise<{ blob: Blob; filename: string }> {
	if (isRecord(value) && Array.isArray(value.parts)) {
		if (value.parts.length === 0 || value.parts.length > 20) {
			throw new ExternalRequestInputError(
				`File parameter "${paramName}" must include between 1 and 20 PDF parts.`,
			);
		}
		const { PDFDocument } = await import("pdf-lib");
		const merged = await PDFDocument.create();
		for (const part of value.parts) {
			const source = fileParamToBytes(paramName, part);
			let pdf: PdfDocument;
			try {
				pdf = await PDFDocument.load(source.bytes);
			} catch {
				throw new ExternalRequestInputError(
					`File parameter "${paramName}" contains a part that is not a valid PDF.`,
				);
			}
			const pages = await merged.copyPages(pdf, pdf.getPageIndices());
			for (const page of pages) merged.addPage(page);
		}
		const bytes = await merged.save();
		const filename =
			typeof value.filename === "string" && value.filename.trim()
				? value.filename.trim()
				: `${paramName}.pdf`;
		return {
			blob: new Blob([bytes], { type: "application/pdf" }),
			filename,
		};
	}

	const file = fileParamToBytes(paramName, value);
	return {
		blob: new Blob([file.bytes], { type: file.mimeType }),
		filename: file.filename,
	};
}

export async function buildMultipartBody(
	params: Record<string, unknown>,
	fileParams: string[],
): Promise<FormData> {
	const form = new FormData();
	const fileParamSet = new Set(fileParams);

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (fileParamSet.has(key)) {
			const file = await fileParamToBlob(key, value);
			form.append(key, file.blob, file.filename);
			continue;
		}
		appendScalarFormValue((next) => form.append(key, next), value);
	}

	return form;
}

export function buildUrlEncodedBody(
	params: Record<string, unknown>,
): URLSearchParams {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		appendScalarFormValue((next) => body.append(key, next), value);
	}
	return body;
}

export function fileParamsFromConfig(config: ToolConfig): string[] {
	return readToolConfigStringArray(config, "fileParams");
}

export function stringParamsFromConfig(
	config: ToolConfig,
	key: "headerParams" | "queryParams" | "runtimeOnlyParams",
): string[] {
	return readToolConfigStringArray(config, key);
}

/**
 * Tedix-private `x-mcp-header`: a tool config can declare a static map of
 * custom headers forwarded on the upstream/rpc/external request. Values support
 * `{paramName}` placeholders resolved from (and consumed out of) tool input,
 * mirroring `staticHeaders`. Header names are normalized so a tool cannot
 * override Tedix-managed `X-Tedix-*`/`Authorization` headers.
 *
 * This is intentionally not SEP-2243's schema-level `x-mcp-header`, which maps
 * tool input properties to `Mcp-Param-*` request headers.
 */
export function applyMcpCustomHeaders(
	headers: Record<string, string>,
	config: ToolConfig,
	params: Record<string, unknown>,
): void {
	const raw = readToolConfigExtension(config, "x-mcp-header");
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") continue;
		const lower = name.toLowerCase();
		// Do not let config-declared headers clobber Tedix-managed identity/auth.
		if (lower === "authorization" || lower.startsWith("x-tedix-")) continue;
		const resolved = value.replace(/\{(\w+)\}/g, (_, key: string) => {
			const v = params[key];
			if (v !== undefined && v !== null) {
				delete params[key];
				return String(v);
			}
			return "";
		});
		if (resolved) headers[name] = resolved;
	}
}

export function consumeNamedParams(
	params: Record<string, unknown>,
	names: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of names) {
		const value = params[name];
		if (value === undefined || value === null) continue;
		out[name] = value;
		delete params[name];
	}
	return out;
}

function filenameFromContentDisposition(
	contentDisposition: string | null,
): string | null {
	if (!contentDisposition) return null;
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
		} catch {
			return encoded.replace(/^"|"$/g, "");
		}
	}
	return /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1]?.trim() ?? null;
}

function isTextResponseContentType(contentType: string): boolean {
	const normalized = normalizedContentType(contentType);
	return (
		normalized.startsWith("text/") ||
		normalized.includes("xml") ||
		normalized.includes("html") ||
		normalized.includes("csv") ||
		normalized.includes("yaml")
	);
}

export function textExternalRequestBody(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "body")
	) {
		const body = (value as Record<string, unknown>).body;
		return typeof body === "string" ? body : JSON.stringify(body ?? "");
	}
	return JSON.stringify(value ?? "");
}

export async function parseExternalResponse(
	response: Response,
	config: ToolConfig,
): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	const normalizedType = normalizedContentType(contentType);
	const responseMode = config.responseMode ?? "auto";
	const isJsonResponse =
		normalizedType === "application/json" || normalizedType.endsWith("+json");

	if (
		(response.status >= 400 && isJsonResponse) ||
		responseMode === "json" ||
		(responseMode === "auto" && isJsonResponse)
	) {
		return response.json();
	}
	if (
		responseMode === "text" ||
		(responseMode === "auto" && isTextResponseContentType(contentType))
	) {
		return response.text();
	}

	const buffer = await response.arrayBuffer();
	const result: Record<string, unknown> = {
		filename: filenameFromContentDisposition(
			response.headers.get("content-disposition"),
		),
		mimeType: contentType || "application/octet-stream",
		base64encoded: true,
		content: arrayBufferToBase64(buffer),
	};
	if (normalizedType === "application/pdf") {
		try {
			const { PDFDocument } = await import("pdf-lib");
			result.pageCount = (await PDFDocument.load(buffer)).getPageCount();
		} catch {
			// Return the upstream bytes even if PDF metadata cannot be inspected.
		}
	}
	return result;
}
