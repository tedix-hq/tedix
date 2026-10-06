import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { AppBindings } from "../types";
import { mediaUpload } from "./cms-proxy-media";
import { type CmsProxyContext, callCmsRest } from "./cms-proxy-runtime";
import { getCmsAppMetadata } from "./storage";
import { unwrapCmsToolResult } from "./tool-result";

export type ImageGenerationStatusValue =
	| "queued"
	| "running"
	| "complete"
	| "failed";

export interface ImageGenerationAttachTarget {
	collection: string;
	id: string;
	fieldName?: string;
	locale?: string;
	updateSeoOgImage?: boolean;
}

export interface ImageGenerationWorkflowParams {
	orgSlug: string;
	prompt?: string;
	title?: string;
	description?: string;
	role?: string;
	aspectRatio?: string;
	width?: number;
	height?: number;
	style?: string;
	brandContext?: string;
	constraints?: string[];
	avoid?: string[];
	allowPeople?: boolean;
	locale?: string;
	alt?: string;
	caption?: string;
	filename?: string;
	model?: string;
	seed?: number;
	attachTo?: ImageGenerationAttachTarget;
}

export interface ImageGenerationPhaseEvent {
	phase: string;
	status: ImageGenerationStatusValue;
	message?: string;
	timestamp: string;
	details?: Record<string, unknown>;
}

export interface ImageGenerationStatusSnapshot {
	jobId: string;
	orgSlug: string;
	phase: string;
	status: ImageGenerationStatusValue;
	message?: string;
	updatedAt: string;
	history: ImageGenerationPhaseEvent[];
	details?: Record<string, unknown>;
	result?: ImageGenerationResult;
	error?: string;
}

export interface ImageGenerationResult {
	model: string;
	prompt: string;
	mimeType: string;
	filename: string;
	width?: number;
	height?: number;
	media: Record<string, unknown>;
	mediaValue: Record<string, unknown>;
	attached?: {
		collection: string;
		id: string;
		fieldName: string;
		updateSeoOgImage: boolean;
	};
}

type TenantImageDefaults = {
	model?: string;
	style?: string;
	brandContext?: string;
	constraints?: string[];
	avoid?: string[];
	allowPeople?: boolean;
	aspectRatio?: string;
};

type GeminiImageResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				inlineData?: { mimeType?: string; data?: string };
				text?: string;
			}>;
		};
	}>;
	error?: { message?: string };
};

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const DEFAULT_ASPECT_RATIO = "16:9";
// gemini-2.5-flash-image only honors these exact presets via
// generationConfig.imageConfig.aspectRatio; anything else is ignored and the
// model silently falls back to its native 1:1 output.
const SUPPORTED_ASPECT_RATIOS = [
	"21:9",
	"16:9",
	"4:3",
	"3:2",
	"1:1",
	"9:16",
	"3:4",
	"2:3",
	"5:4",
	"4:5",
] as const;
const DEFAULT_AVOID = [
	"readable text",
	"logos",
	"watermarks",
	"brand names",
	"distorted anatomy",
	"stretched faces",
	"extra fingers",
];

export function imageGenerationStatusKey(jobId: string): string {
	return `media/image-generation-status/${jobId}.json`;
}

async function recordImagePhase(
	storage: R2Bucket,
	event: {
		jobId: string;
		orgSlug: string;
		phase: string;
		status: ImageGenerationStatusValue;
		message?: string;
		details?: Record<string, unknown>;
		result?: ImageGenerationResult;
		error?: string;
	},
): Promise<void> {
	const timestamp = new Date().toISOString();
	const priorObj = await storage.get(imageGenerationStatusKey(event.jobId));
	let history: ImageGenerationPhaseEvent[] = [];
	if (priorObj) {
		try {
			const prior =
				(await priorObj.json()) as Partial<ImageGenerationStatusSnapshot>;
			if (Array.isArray(prior.history)) history = prior.history;
		} catch {
			history = [];
		}
	}

	const entry: ImageGenerationPhaseEvent = {
		phase: event.phase,
		status: event.status,
		message: event.message,
		timestamp,
		details: event.details,
	};
	history.push(entry);

	const snapshot: ImageGenerationStatusSnapshot = {
		jobId: event.jobId,
		orgSlug: event.orgSlug,
		phase: event.phase,
		status: event.status,
		message: event.message,
		updatedAt: timestamp,
		history: history.slice(-80),
		details: event.details,
		result: event.result,
		error: event.error,
	};
	await storage.put(
		imageGenerationStatusKey(event.jobId),
		JSON.stringify(snapshot),
	);
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
	if (!raw) return {};
	if (typeof raw === "object" && !Array.isArray(raw))
		return raw as Record<string, unknown>;
	if (typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function getRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim().length > 0,
	);
	return items.length > 0 ? items : undefined;
}

async function loadTenantDefaults(
	db: D1Database,
	orgSlug: string,
): Promise<TenantImageDefaults> {
	const metadata = parseJsonRecord(await getCmsAppMetadata(db, orgSlug));
	const branding = getRecord(metadata.branding);
	const blogConfig = getRecord(metadata.blogConfig);
	const candidates = [
		getRecord(metadata.imageGeneration),
		getRecord(blogConfig.imageGeneration),
		getRecord(branding.imageGeneration),
	];
	const merged = Object.assign({}, ...candidates);

	const colors = getRecord(branding.colors);
	const fonts = getRecord(branding.fonts);
	const brandParts = [
		typeof branding.homepageUrl === "string"
			? `official homepage ${branding.homepageUrl}`
			: undefined,
		Object.keys(colors).length > 0
			? `brand colors ${Object.values(colors).slice(0, 6).join(", ")}`
			: undefined,
		Object.keys(fonts).length > 0
			? `brand fonts ${Object.values(fonts).slice(0, 3).join(", ")}`
			: undefined,
	].filter(Boolean);

	return {
		model: typeof merged.model === "string" ? merged.model : undefined,
		style: typeof merged.style === "string" ? merged.style : undefined,
		brandContext:
			typeof merged.brandContext === "string"
				? merged.brandContext
				: brandParts.join("; ") || undefined,
		constraints: stringArray(merged.constraints),
		avoid: stringArray(merged.avoid),
		allowPeople:
			typeof merged.allowPeople === "boolean" ? merged.allowPeople : undefined,
		aspectRatio:
			typeof merged.aspectRatio === "string" ? merged.aspectRatio : undefined,
	};
}

function sanitizeFilenamePart(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 90);
}

function mimeExtension(mimeType: string): string {
	if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
	if (mimeType.includes("webp")) return "webp";
	return "png";
}

function inferDimensions(bytes: Uint8Array, mimeType: string) {
	const byteAt = (index: number) => bytes[index] ?? 0;
	if (
		bytes.length >= 24 &&
		mimeType.includes("png") &&
		byteAt(0) === 0x89 &&
		byteAt(1) === 0x50 &&
		byteAt(2) === 0x4e &&
		byteAt(3) === 0x47
	) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}

	if (
		bytes.length > 4 &&
		(mimeType.includes("jpeg") || mimeType.includes("jpg"))
	) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (byteAt(offset) !== 0xff) break;
			const marker = byteAt(offset + 1);
			const length = (byteAt(offset + 2) << 8) + byteAt(offset + 3);
			if (length < 2) break;
			if (
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			) {
				return {
					height: (byteAt(offset + 5) << 8) + byteAt(offset + 6),
					width: (byteAt(offset + 7) << 8) + byteAt(offset + 8),
				};
			}
			offset += 2 + length;
		}
	}

	return {};
}

function base64ToBytes(base64: string): Uint8Array {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function extractMediaItem(uploaded: unknown): Record<string, unknown> {
	const record = getRecord(uploaded);
	const item = getRecord(record.item);
	if (Object.keys(item).length > 0) return item;
	const data = getRecord(record.data);
	const dataItem = getRecord(data.item);
	if (Object.keys(dataItem).length > 0) return dataItem;
	return record;
}

/** Read and guard one image attachment; a lost write response must not be replayed. */
export async function attachGeneratedImage(
	ctx: CmsProxyContext,
	target: ImageGenerationAttachTarget,
	mediaValue: Record<string, unknown>,
) {
	const read = await callCmsRest(ctx, "content_get", {
		collection: target.collection,
		id: target.id,
		locale: target.locale,
	});
	const current = getRecord(
		getRecord(unwrapCmsToolResult(read, "CMS image attachment read")).data,
	);
	const item = getRecord(current.item);
	if (
		typeof current._rev !== "string" ||
		!current._rev ||
		typeof item.id !== "string" ||
		!item.id
	) {
		throw new Error(
			"CMS image attachment read returned no canonical item and revision; content was not changed",
		);
	}
	const update: Record<string, unknown> = {
		collection: target.collection,
		id: item.id,
		_rev: current._rev,
		data: { [target.fieldName ?? "featured_image"]: mediaValue },
	};
	const storageKey = getRecord(mediaValue.meta).storageKey;
	if (target.updateSeoOgImage && typeof storageKey === "string" && storageKey)
		update.seo = { ogImage: storageKey };
	const result = await callCmsRest(ctx, "content_update", update);
	unwrapCmsToolResult(result, "CMS image attachment update");
	return result;
}

function buildMediaValue(
	media: Record<string, unknown>,
	fallback: { width?: number; height?: number; alt?: string; mimeType: string },
): Record<string, unknown> {
	return {
		provider: "local",
		id: media.id,
		filename: media.filename,
		mimeType: media.mime_type ?? media.mimeType ?? fallback.mimeType,
		width: media.width ?? fallback.width,
		height: media.height ?? fallback.height,
		alt: media.alt ?? fallback.alt,
		caption: media.caption ?? undefined,
		meta: {
			storageKey: media.storage_key ?? media.storageKey,
			blurhash: media.blurhash ?? undefined,
			dominantColor: media.dominant_color ?? media.dominantColor ?? undefined,
		},
	};
}

function resolveAspectRatio(
	params: ImageGenerationWorkflowParams,
	defaults: TenantImageDefaults,
): string {
	if (params.aspectRatio) return params.aspectRatio;
	if (params.width && params.height) return `${params.width}:${params.height}`;
	return defaults.aspectRatio ?? DEFAULT_ASPECT_RATIO;
}

function parseRatio(input: string): number | undefined {
	const wxh = input
		.trim()
		.match(/^(\d+(?:\.\d+)?)\s*[x×:]\s*(\d+(?:\.\d+)?)$/i);
	if (!wxh) return undefined;
	const w = Number(wxh[1]);
	const h = Number(wxh[2]);
	return w > 0 && h > 0 ? w / h : undefined;
}

// Maps a free-form ratio/dimension string to the nearest Gemini-supported
// preset so the API param is always one it actually recognizes.
function nearestSupportedAspectRatio(input: string): string {
	const ratio = parseRatio(input);
	if (ratio === undefined) return DEFAULT_ASPECT_RATIO;
	let best: (typeof SUPPORTED_ASPECT_RATIOS)[number] = DEFAULT_ASPECT_RATIO;
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const candidate of SUPPORTED_ASPECT_RATIOS) {
		const [w = 0, h = 1] = candidate.split(":").map(Number);
		const diff = Math.abs(w / h - ratio);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = candidate;
		}
	}
	return best;
}

function buildPrompt(
	params: ImageGenerationWorkflowParams,
	defaults: TenantImageDefaults,
): string {
	const subject = [params.prompt, params.title, params.description]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.join("\n\n");
	if (!subject) {
		throw new Error(
			"At least one of prompt, title, or description is required",
		);
	}

	const role = params.role ?? "featured editorial article image";
	const aspectRatio = resolveAspectRatio(params, defaults);
	const style =
		params.style ?? defaults.style ?? "premium editorial photography";
	const brandContext = params.brandContext ?? defaults.brandContext;
	const constraints = [
		...(defaults.constraints ?? []),
		...(params.constraints ?? []),
	];
	const avoid = [
		...DEFAULT_AVOID,
		...(defaults.avoid ?? []),
		...(params.avoid ?? []),
	];
	const allowPeople = params.allowPeople ?? defaults.allowPeople ?? false;
	if (!allowPeople) {
		avoid.push("people", "faces", "hands as the main subject");
	}
	if (params.seed !== undefined) {
		constraints.push(`use stable visual seed ${params.seed}`);
	}

	return [
		`Create a ${role}.`,
		`Subject: ${subject}`,
		`Style: ${style}.`,
		`Aspect ratio: ${aspectRatio}.`,
		params.width && params.height
			? `Preferred output dimensions: ${params.width}x${params.height}.`
			: undefined,
		params.locale ? `Locale and market context: ${params.locale}.` : undefined,
		brandContext ? `Brand context: ${brandContext}.` : undefined,
		constraints.length > 0
			? `Required constraints: ${constraints.join("; ")}.`
			: undefined,
		`Avoid: ${Array.from(new Set(avoid)).join("; ")}.`,
		"No text overlay. No watermark. Natural proportions. Professional, trustworthy composition.",
	]
		.filter(Boolean)
		.join("\n");
}

async function generateGeminiImage(
	apiKey: string,
	model: string,
	prompt: string,
	aspectRatio: string,
): Promise<{ mimeType: string; dataBase64: string }> {
	// Vertex AI express endpoint (aiplatform), not AI Studio (generativelanguage).
	// AI Studio uses a separate prepay credit pool that 403/429s when empty and
	// that Cloud/startup credits cannot fund; Vertex on-demand bills to the GCP
	// project's Cloud billing account (startup-credit eligible). Same model id
	// works on both. Vertex requires contents[].role and the key as a header.
	const resp = await fetch(
		`https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": apiKey,
			},
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: prompt }] }],
				generationConfig: {
					responseModalities: ["IMAGE"],
					imageConfig: { aspectRatio },
				},
			}),
		},
	);

	const text = await resp.text();
	let json: GeminiImageResponse;
	try {
		json = JSON.parse(text) as GeminiImageResponse;
	} catch {
		throw new Error(
			`Gemini ${model} returned non-JSON (${resp.status}): ${text.slice(0, 300)}`,
		);
	}
	if (!resp.ok) {
		throw new Error(
			`Gemini ${model} failed (${resp.status}): ${json.error?.message ?? text.slice(0, 300)}`,
		);
	}
	const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
	const inline = part?.inlineData;
	if (!inline?.data) {
		throw new Error(`Gemini ${model} returned no image part`);
	}
	return {
		mimeType: inline.mimeType ?? "image/png",
		dataBase64: inline.data,
	};
}

export class ImageGenerationWorkflow extends WorkflowEntrypoint<
	AppBindings,
	ImageGenerationWorkflowParams
> {
	async run(
		event: WorkflowEvent<ImageGenerationWorkflowParams>,
		step: WorkflowStep,
	): Promise<ImageGenerationResult> {
		const params = event.payload;
		const jobId = event.instanceId;
		await recordImagePhase(this.env.SITE_BUILDER_STORAGE, {
			jobId,
			orgSlug: params.orgSlug,
			phase: "queued",
			status: "queued",
			message: "Image generation queued",
		});

		try {
			const defaults = await step.do(
				"load-tenant-image-defaults",
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "20 seconds" },
				() => loadTenantDefaults(this.env.DB, params.orgSlug),
			);
			const prompt = buildPrompt(params, defaults);
			const model = params.model ?? defaults.model ?? DEFAULT_MODEL;
			const apiAspectRatio = nearestSupportedAspectRatio(
				resolveAspectRatio(params, defaults),
			);
			await recordImagePhase(this.env.SITE_BUILDER_STORAGE, {
				jobId,
				orgSlug: params.orgSlug,
				phase: "prompt",
				status: "running",
				message: "Prompt prepared",
				details: {
					model,
					role: params.role,
					aspectRatio: params.aspectRatio,
					apiAspectRatio,
				},
			});

			const generated = await step.do(
				"generate-image",
				{ retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" },
				() =>
					generateGeminiImage(
						this.env.GEMINI_API_KEY,
						model,
						prompt,
						apiAspectRatio,
					),
			);
			const bytes = base64ToBytes(generated.dataBase64);
			const dimensions = inferDimensions(bytes, generated.mimeType);
			await recordImagePhase(this.env.SITE_BUILDER_STORAGE, {
				jobId,
				orgSlug: params.orgSlug,
				phase: "generated",
				status: "running",
				message: "Image generated",
				details: {
					mimeType: generated.mimeType,
					size: bytes.byteLength,
					...dimensions,
				},
			});

			const extension = mimeExtension(generated.mimeType);
			const filename =
				params.filename ??
				`${sanitizeFilenamePart(params.title ?? params.prompt ?? "generated-image")}-${jobId.slice(0, 8)}.${extension}`;
			const cmsCtx: CmsProxyContext = {
				orgSlug: params.orgSlug,
				forwardedAuth: undefined,
				serviceApiKey: undefined,
				internalAuthToken: this.env.CMS_INTERNAL_AUTH_TOKEN,
				environment: this.env.ENVIRONMENT || "production",
				cmsDispatch: this.env.CMS_DISPATCH,
			};
			const uploadResult = await step.do(
				"upload-media",
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "45 seconds" },
				() =>
					mediaUpload(cmsCtx, {
						filename,
						mimeType: generated.mimeType,
						dataBase64: generated.dataBase64,
						alt: params.alt ?? params.title ?? params.prompt,
						caption: params.caption,
					}),
			);
			if (uploadResult.isError) {
				throw new Error(uploadResult.content[0]?.text ?? "Media upload failed");
			}
			const media = extractMediaItem(
				unwrapCmsToolResult(uploadResult, "CMS image upload"),
			);
			const mediaValue = buildMediaValue(media, {
				...dimensions,
				alt: params.alt ?? params.title ?? params.prompt,
				mimeType: generated.mimeType,
			});

			let attached: ImageGenerationResult["attached"];
			if (params.attachTo) {
				const fieldName = params.attachTo.fieldName ?? "featured_image";

				await step.do(
					"attach-to-content",
					{ retries: { limit: 0, delay: "2 seconds" }, timeout: "45 seconds" },
					() => attachGeneratedImage(cmsCtx, params.attachTo!, mediaValue),
				);

				attached = {
					collection: params.attachTo.collection,
					id: params.attachTo.id,
					fieldName,
					updateSeoOgImage: Boolean(params.attachTo.updateSeoOgImage),
				};
			}

			const result: ImageGenerationResult = {
				model,
				prompt,
				mimeType: generated.mimeType,
				filename,
				...dimensions,
				media,
				mediaValue,
				attached,
			};
			await recordImagePhase(this.env.SITE_BUILDER_STORAGE, {
				jobId,
				orgSlug: params.orgSlug,
				phase: "complete",
				status: "complete",
				message: "Image generated and stored in Emdash media",
				result,
			});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await recordImagePhase(this.env.SITE_BUILDER_STORAGE, {
				jobId,
				orgSlug: params.orgSlug,
				phase: "failed",
				status: "failed",
				message,
				error: message,
			});
			throw err;
		}
	}
}
