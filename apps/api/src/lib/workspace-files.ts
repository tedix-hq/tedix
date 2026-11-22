import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import {
	WORKSPACE_FILE_PART_BYTES,
	WorkspaceFileManifestSchema,
	workspaceFileKey,
} from "@tedix/api-contract/schemas/workspace-files";
import type { OsDocumentBlock } from "@tedix/api-contract/schemas/os-workspaces";
import { officeExtractBlocks } from "@tedix/api-contract/utils/office-file-blocks";
import {
	officeFileFormat,
	readOfficeFile,
} from "@tedix/api-contract/utils/office-file-read";
import {
	boundedFileText,
	decodeTextFile,
	isTextFile,
	officeFileText,
	plainFileText,
	workspaceFileTextKey,
	type WorkspaceFileText,
} from "@tedix/api-contract/utils/workspace-file-text";
import { DataResidencyError } from "../services/data-residency";
import { splitConvertedPdf } from "../workflows/content-ingestion-pdf";

export async function readWorkspaceFileManifest(
	env: Pick<CloudflareEnv, "SKILL_ARTIFACTS">,
	org: string,
	workspace: string,
	resource: string,
) {
	const object = await env.SKILL_ARTIFACTS.get(
		`${workspaceFileKey(org, workspace, resource)}.json`,
	);
	if (!object) return null;
	const manifest = WorkspaceFileManifestSchema.parse(await object.json());
	if (
		manifest.organizationId !== org ||
		manifest.workspaceId !== workspace ||
		manifest.resourceId !== resource
	)
		return null;
	return manifest;
}
export async function workspaceFileSignature(
	secret: string,
	action: string,
	org: string,
	workspace: string,
	resource: string,
	exp: number,
) {
	const key = await deriveHkdfHmacKey(secret, "tedix-workspace-file:v1");
	return base64UrlEncode(
		await hmacSha256(
			key,
			JSON.stringify([action, org, workspace, resource, exp]),
		),
	);
}
export async function verifyWorkspaceFileSignature(
	secret: string,
	action: string,
	org: string,
	workspace: string,
	resource: string,
	url: URL,
) {
	const exp = Number(url.searchParams.get("exp"));
	if (
		!Number.isSafeInteger(exp) ||
		exp * 1000 <= Date.now() ||
		exp * 1000 > Date.now() + 900_000
	)
		return false;
	const expected = await workspaceFileSignature(
		secret,
		action,
		org,
		workspace,
		resource,
		exp,
	);
	const sig = url.searchParams.get("sig") ?? "";
	if (sig.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < sig.length; i++)
		diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}
export function workspaceFilePartSize(size: number, part: number) {
	const count = Math.ceil(size / WORKSPACE_FILE_PART_BYTES);
	return Number.isInteger(part) && part >= 1 && part <= count
		? Math.min(
				WORKSPACE_FILE_PART_BYTES,
				size - (part - 1) * WORKSPACE_FILE_PART_BYTES,
			)
		: null;
}
/** Active content is download-only, even when the uploaded MIME claims otherwise. */
export function workspaceFileInlineMime(mime: string) {
	return [
		"video/mp4",
		"video/webm",
		"video/quicktime",
		"application/pdf",
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif",
		"image/avif",
	].includes(mime)
		? mime
		: null;
}

/** Check only the bounded prefix; unknown or truncated signatures fail closed. */
export function workspaceFileMimeMatches(mime: string, bytes: Uint8Array) {
	const matches = (signature: number[], offset = 0) =>
		signature.every((byte, index) => bytes[offset + index] === byte);
	const text = (offset: number, length: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + length));
	switch (mime) {
		case "application/pdf":
			return text(0, 5) === "%PDF-";
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		case "application/vnd.ms-excel.sheet.macroenabled.12":
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
			return matches([80, 75, 3, 4]);
		case "text/csv":
		case "text/tab-separated-values":
		// Text has no signature; a zero byte in the start rules it out. Markup
		// and script types stay unconfirmed: those files are read as text by name.
		case "text/plain":
		case "text/markdown":
		case "text/x-markdown":
		case "application/json":
		case "application/yaml":
		case "application/x-yaml":
		case "text/yaml":
		case "application/toml":
			return bytes.length > 0 && !bytes.includes(0);
		case "image/png":
			return matches([137, 80, 78, 71, 13, 10, 26, 10]);
		case "image/jpeg":
			return matches([255, 216, 255]);
		case "image/gif":
			return ["GIF87a", "GIF89a"].includes(text(0, 6));
		case "image/webp":
			return text(0, 4) === "RIFF" && text(8, 4) === "WEBP";
		case "video/webm":
			return (
				matches([26, 69, 223, 163]) &&
				bytes.some((_, index) =>
					matches([66, 130, 132, 119, 101, 98, 109], index),
				)
			);
		case "video/mp4":
		case "video/quicktime":
		case "image/avif": {
			if (bytes.length < 16 || text(4, 4) !== "ftyp") return false;
			const size = new DataView(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			).getUint32(0);
			if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
			const brand = text(8, 4);
			if (mime === "video/quicktime") return brand === "qt  ";
			if (mime === "image/avif") return ["avif", "avis"].includes(brand);
			return ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(
				brand,
			);
		}
		default:
			return false;
	}
}

/** Larger files keep only their reference; reading them would cost too much memory. */
export const WORKSPACE_FILE_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
/** The size PDF conversion is proven at elsewhere in this app. */
export const WORKSPACE_FILE_PDF_MAX_BYTES = 2 * 1024 * 1024;
const PDF_CONVERSION_TIMEOUT_MS = 20_000;

/** Turns PDF bytes into the converter's markdown; throws when it cannot. */
export type PdfToMarkdown = (
	bytes: Uint8Array,
	name: string,
) => Promise<string>;

/**
 * A converted PDF as lines of text with a "## Page N" line before each page.
 * Null when no page holds text, as with a scan: nothing here reads images.
 */
export function pdfFileText(markdown: string, name: string): string | null {
	const { body } = splitConvertedPdf(markdown, name);
	const marks = [...body.matchAll(/^### Page (\d+)[ \t]*$/gm)];
	const pages = marks.length
		? marks.map((mark, index) => ({
				page: mark[1]!,
				text: body
					.slice(mark.index + mark[0].length, marks[index + 1]?.index)
					.trim(),
			}))
		: [{ page: "", text: body.trim() }];
	if (pages.every((page) => !page.text)) return null;
	const lines: string[] = [];
	for (const page of pages) {
		if (page.page) lines.push(`## Page ${page.page}`, "");
		lines.push(
			...(page.text || "(This page has no readable text.)").split("\n"),
			"",
		);
	}
	return boundedFileText(lines);
}

/**
 * What can be read from an uploaded file: the start of a spreadsheet, Word
 * document or slide deck as bounded document blocks stored on its document,
 * and the whole text of those, of a PDF and of a plain text, Markdown, JSON,
 * code or config file for reading in parts. A file that
 * cannot be read gets no blocks and a status that says why: the upload itself
 * never fails here.
 */
export async function readWorkspaceFileContent(
	env: Pick<CloudflareEnv, "SKILL_ARTIFACTS">,
	key: string,
	file: { filename: string; mimeType: string; size: number },
	pdfToMarkdown?: PdfToMarkdown,
): Promise<{ blocks: OsDocumentBlock[]; text: WorkspaceFileText }> {
	const none = (status: WorkspaceFileText["status"]) => ({
		blocks: [],
		text: { status, text: "" },
	});
	const format = officeFileFormat(file.filename, file.mimeType);
	const pdf = !format && file.mimeType === "application/pdf";
	const plain =
		!format &&
		!pdf &&
		(isTextFile(file.filename, file.mimeType) ||
			// A leading dot names a hidden file (.gitignore), not an extension.
			(!file.filename.replace(/^\./, "").includes(".") &&
				(!file.mimeType ||
					file.mimeType.toLowerCase() === "application/octet-stream")));
	if (!format && !pdf && !plain) return none("unsupported");
	if (
		file.size >
		(pdf ? WORKSPACE_FILE_PDF_MAX_BYTES : WORKSPACE_FILE_EXTRACT_MAX_BYTES)
	)
		return none("too_large");
	try {
		const object = await env.SKILL_ARTIFACTS.get(key);
		if (!object || object.size !== file.size) return none("failed");
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (format) {
			const content = await readOfficeFile(bytes, format);
			return {
				blocks: officeExtractBlocks(content),
				text: { status: "text", text: officeFileText(content) },
			};
		}
		if (plain) {
			// A file named or typed as text whose bytes are not text is read
			// as no text at all, never as replacement characters.
			const text = decodeTextFile(bytes);
			return text === null
				? none("unsupported")
				: { blocks: [], text: { status: "text", text: plainFileText(text) } };
		}
		if (!pdfToMarkdown) return none("failed");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const markdown = await Promise.race([
			pdfToMarkdown(bytes, file.filename),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("PDF conversion timed out")),
					PDF_CONVERSION_TIMEOUT_MS,
				);
			}),
		]).finally(() => clearTimeout(timer));
		const text = pdfFileText(markdown, file.filename);
		return text === null
			? none("no_text")
			: { blocks: [], text: { status: "text", text } };
	} catch (error) {
		if (error instanceof DataResidencyError) return none("not_allowed");
		console.warn("Workspace file text could not be read", {
			format: format ?? (plain ? "text" : "pdf"),
			error: error instanceof Error ? error.message : String(error),
		});
		return none("failed");
	}
}

/**
 * Keep a file's whole text where the workspace's agent reads it in parts.
 * Losing it costs only that later reading, so a failed write is not an error.
 */
export async function storeWorkspaceFileText(
	env: Pick<CloudflareEnv, "R2_BUCKET">,
	file: { organizationId: string; workspaceId: string; resourceId: string },
	text: WorkspaceFileText,
) {
	try {
		await env.R2_BUCKET.put(
			workspaceFileTextKey(
				file.organizationId,
				file.workspaceId,
				file.resourceId,
			),
			JSON.stringify(text),
		);
	} catch (error) {
		console.warn("Workspace file text could not be kept", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Stream one stored workspace file, honouring a single HTTP byte range so a
 * video can seek. The caller has already authorized the read; `size` is the
 * manifest's, so a replaced or missing object answers 404.
 */
export async function streamWorkspaceFile(
	request: Request,
	env: Pick<CloudflareEnv, "SKILL_ARTIFACTS">,
	file: { key: string; size: number; mimeType: string; filename: string },
): Promise<Response> {
	let range: { offset: number; length: number } | undefined;
	const rawRange = request.headers.get("Range");
	if (rawRange) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
		if (!match || (!match[1] && !match[2])) return rangeError(file.size);
		const start = match[1]
			? Number(match[1])
			: Math.max(0, file.size - Number(match[2]));
		const end = match[1]
			? match[2]
				? Math.min(Number(match[2]), file.size - 1)
				: file.size - 1
			: file.size - 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			start >= file.size
		)
			return rangeError(file.size);
		range = { offset: start, length: end - start + 1 };
	}
	const object =
		request.method === "HEAD"
			? await env.SKILL_ARTIFACTS.head(file.key)
			: await env.SKILL_ARTIFACTS.get(file.key, range ? { range } : undefined);
	if (!object || object.size !== file.size)
		return new Response("Not found", { status: 404 });
	const inline = workspaceFileInlineMime(file.mimeType);
	const headers = new Headers({
		"Content-Type": inline ?? "application/octet-stream",
		"Content-Length": String(range?.length ?? file.size),
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "sandbox; default-src 'none'",
	});
	if (range)
		headers.set(
			"Content-Range",
			`bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
		);
	return new Response("body" in object ? (object as R2ObjectBody).body : null, {
		status: range ? 206 : 200,
		headers,
	});
}

function rangeError(size: number) {
	return new Response(null, {
		status: 416,
		headers: {
			"Content-Range": `bytes */${size}`,
			"Cache-Control": "private, no-store",
		},
	});
}
