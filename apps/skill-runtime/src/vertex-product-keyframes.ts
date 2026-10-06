import {
	MAX_REFERENCE_IMAGES,
	validateReferenceImages,
	type InlineReferenceImage,
} from "./vertex-video-judge";

export const MAX_KEYFRAME_CANDIDATES = 4;
export const MAX_VEO_ASSET_REFERENCES = 3;
export const PRODUCT_KEYFRAME_FIDELITY_THRESHOLD = 85;

export interface ProductKeyframeRequest {
	productContext: string;
	prompt: string;
	referenceImages: InlineReferenceImage[];
	sampleCount?: number;
	/**
	 * Frame shape for the generated keyframes. This has to match the shape the
	 * motion step will request: Veo pillarboxes a 16:9 source frame into a 9:16
	 * canvas rather than reframing it, so a vertical clip built from a landscape
	 * keyframe is mostly black bars. Defaults to 16:9 for existing callers.
	 */
	aspectRatio?: "16:9" | "9:16";
}

export interface VeoAssetReferenceRequest {
	model: string;
	prompt: string;
	referenceImages: InlineReferenceImage[];
	aspectRatio?: "16:9" | "9:16";
	durationSeconds?: 8;
}

export interface VeoBackgroundRequest {
	model: string;
	prompt: string;
	aspectRatio?: "16:9" | "9:16";
	durationSeconds?: 8;
}

export function validateVeoBackgroundRequest(
	input: unknown,
): Required<VeoBackgroundRequest> {
	const value = input as Partial<VeoBackgroundRequest> | null;
	if (
		!value ||
		typeof value.model !== "string" ||
		!/^veo-3\.1-(fast-)?generate-(001|preview)$/.test(value.model)
	)
		throw new Error("supported Veo 3.1 model required");
	if (
		typeof value.prompt !== "string" ||
		value.prompt.length < 1 ||
		value.prompt.length > 8_000
	)
		throw new Error("prompt must be 1-8000 characters");
	const aspectRatio = value.aspectRatio ?? "16:9";
	if (!(["16:9", "9:16"] as const).includes(aspectRatio))
		throw new Error("aspectRatio must be 16:9 or 9:16");
	if (value.durationSeconds !== undefined && value.durationSeconds !== 8)
		throw new Error("Veo background generation requires 8 seconds");
	return {
		model: value.model,
		prompt: value.prompt,
		aspectRatio,
		durationSeconds: 8,
	};
}

export function veoBackgroundRequest(
	input: Required<VeoBackgroundRequest>,
): unknown {
	return {
		instances: [{ prompt: input.prompt }],
		parameters: {
			aspectRatio: input.aspectRatio,
			sampleCount: 1,
			durationSeconds: input.durationSeconds,
		},
	};
}

export function validateVeoAssetReferenceRequest(
	input: unknown,
): Required<VeoAssetReferenceRequest> {
	const value = input as Partial<VeoAssetReferenceRequest> | null;
	if (
		!value ||
		typeof value.model !== "string" ||
		!/^veo-3\.1-(fast-)?generate-(001|preview)$/.test(value.model)
	)
		throw new Error("supported Veo 3.1 model required");
	if (
		typeof value.prompt !== "string" ||
		value.prompt.length < 1 ||
		value.prompt.length > 8_000
	)
		throw new Error("prompt must be 1-8000 characters");
	const referenceImages = validateReferenceImages(value.referenceImages);
	if (
		referenceImages.length < 1 ||
		referenceImages.length > MAX_VEO_ASSET_REFERENCES
	)
		throw new Error(
			`1-${MAX_VEO_ASSET_REFERENCES} approved asset references required`,
		);
	const aspectRatio = value.aspectRatio ?? "16:9";
	if (!(["16:9", "9:16"] as const).includes(aspectRatio))
		throw new Error("aspectRatio must be 16:9 or 9:16");
	if (value.durationSeconds !== undefined && value.durationSeconds !== 8)
		throw new Error("Veo asset-reference generation requires 8 seconds");
	return {
		model: value.model,
		prompt: value.prompt,
		referenceImages,
		aspectRatio,
		durationSeconds: 8,
	};
}

export function veoAssetReferenceRequest(
	input: Required<VeoAssetReferenceRequest>,
): unknown {
	return {
		instances: [
			{
				prompt: input.prompt,
				referenceImages: input.referenceImages.map((image) => ({
					image: {
						bytesBase64Encoded: image.data,
						mimeType: image.mimeType,
					},
					referenceType: "asset",
				})),
			},
		],
		parameters: {
			aspectRatio: input.aspectRatio,
			sampleCount: 1,
			durationSeconds: 8,
		},
	};
}

export function validateProductKeyframeRequest(
	input: unknown,
): Required<ProductKeyframeRequest> {
	const value = input as Partial<ProductKeyframeRequest> | null;
	if (
		!value ||
		typeof value.productContext !== "string" ||
		value.productContext.length < 1 ||
		value.productContext.length > 4_000
	) {
		throw new Error("productContext must be 1-4000 characters");
	}
	if (
		typeof value.prompt !== "string" ||
		value.prompt.length < 1 ||
		value.prompt.length > 4_000
	) {
		throw new Error("prompt must be 1-4000 characters");
	}
	const referenceImages = validateReferenceImages(value.referenceImages);
	if (
		referenceImages.length < 1 ||
		referenceImages.length > MAX_REFERENCE_IMAGES
	) {
		throw new Error(
			`1-${MAX_REFERENCE_IMAGES} approved reference images required`,
		);
	}
	const sampleCount = value.sampleCount ?? MAX_KEYFRAME_CANDIDATES;
	if (
		!Number.isInteger(sampleCount) ||
		sampleCount < 1 ||
		sampleCount > MAX_KEYFRAME_CANDIDATES
	) {
		throw new Error(`sampleCount must be 1-${MAX_KEYFRAME_CANDIDATES}`);
	}
	const aspectRatio = value.aspectRatio ?? "16:9";
	if (!(["16:9", "9:16"] as const).includes(aspectRatio))
		throw new Error("aspectRatio must be 16:9 or 9:16");
	return {
		productContext: value.productContext,
		prompt: value.prompt,
		referenceImages,
		sampleCount,
		aspectRatio,
	};
}

export function geminiProductKeyframeRequest(
	input: Required<ProductKeyframeRequest>,
): unknown {
	return {
		contents: [
			{
				role: "user",
				parts: [
					{
						text: [
							`Generate one photorealistic ${input.aspectRatio} commercial keyframe of the exact product shown in all approved references: ${input.productContext}.`,
							input.prompt,
							"Preserve product identity exactly. Change only the environment, camera position, and action moment. Do not redesign geometry, components, colour, proportions, or branding.",
						].join("\n"),
					},
					...input.referenceImages.slice(0, 3).map((image) => ({
						inlineData: { mimeType: image.mimeType, data: image.data },
					})),
				],
			},
		],
		generationConfig: {
			responseModalities: ["TEXT", "IMAGE"],
			candidateCount: 1,
			imageConfig: { aspectRatio: input.aspectRatio },
		},
	};
}

export function extractGeminiKeyframe(
	response: unknown,
	index: number,
): InlineReferenceImage {
	const parts = (
		response as {
			candidates?: Array<{
				content?: {
					parts?: Array<{
						inlineData?: { mimeType?: string; data?: string };
					}>;
				};
			}>;
		}
	)?.candidates?.[0]?.content?.parts;
	const image = parts?.find((part) => part.inlineData?.data)?.inlineData;
	if (!image?.data || !image.mimeType)
		throw new Error(`Vertex Gemini keyframe ${index + 1} is malformed`);
	return {
		data: image.data,
		mimeType: image.mimeType,
		label: `Generated keyframe candidate ${index + 1}`,
	};
}

export function keyframeJudgePrompt(
	productContext: string,
	candidateCount: number,
): string {
	return [
		"You are a fail-closed ecommerce product keyframe judge.",
		"Compare every generated candidate with every approved reference image.",
		"Target faithful perceptual reconstruction rather than pixel identity.",
		"Reject product-class, silhouette, primary-geometry, colourway, distinctive-component, or invented-feature changes. Allow minor texture, reflection, cable, logo-sharpness, and fine-detail drift.",
		`Set approvedCandidateIndexes only to candidates scoring at least ${PRODUCT_KEYFRAME_FIDELITY_THRESHOLD} with no high or critical product-fidelity finding. Use zero-based indexes.`,
		"For every passing candidate, return an empty findings array. Findings are defects only; never put praise, match confirmation, or other positive observations in findings.",
		`Product context: ${productContext}`,
		`Generated candidate count: ${candidateCount}`,
	].join("\n");
}

export const keyframeJudgeResponseSchema = {
	type: "OBJECT",
	properties: {
		approvedCandidateIndexes: { type: "ARRAY", items: { type: "INTEGER" } },
		candidates: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					index: { type: "INTEGER" },
					verdict: { type: "STRING", enum: ["pass", "reject"] },
					productFidelityScore: { type: "INTEGER", minimum: 0, maximum: 100 },
					findings: { type: "ARRAY", items: { type: "STRING" } },
				},
				required: ["index", "verdict", "productFidelityScore", "findings"],
			},
		},
		summary: { type: "STRING" },
	},
	required: ["approvedCandidateIndexes", "candidates", "summary"],
} as const;

export interface KeyframeJudgment {
	approvedCandidateIndexes: number[];
	candidates: Array<{
		index: number;
		verdict: "pass" | "reject";
		productFidelityScore: number;
		findings: string[];
	}>;
	summary: string;
}

export function assertApprovedKeyframe(
	organizationId: string,
	frameR2Key: string,
	metadata: Record<string, string> | undefined,
	receipt: KeyframeGateReceipt,
	receiptSha256: string,
	expectedProductContextSha256: string,
	frameSha256: string,
): void {
	if (
		!metadata ||
		metadata.fidelityStatus !== "approved" ||
		!metadata.gateId ||
		!/^\d+$/.test(metadata.candidateIndex ?? "") ||
		!Number.isFinite(Number(metadata.productFidelityScore)) ||
		Number(metadata.productFidelityScore) < receipt.approvalThreshold ||
		metadata.judgeModel !== "gemini-2.5-pro" ||
		metadata.receiptSha256 !== receiptSha256
	)
		throw new Error("keyframe endpoint lacks a valid fidelity approval");
	if (
		!(
			receipt.schemaVersion === "tedix.product-keyframe-gate.v1" ||
			receipt.schemaVersion === "tedix.product-keyframe-gate.v2"
		) ||
		receipt.gateId !== metadata.gateId ||
		receipt.organizationId !== organizationId ||
		receipt.productContextSha256 !== expectedProductContextSha256 ||
		receipt.judgeModel !== "gemini-2.5-pro" ||
		receipt.approvalThreshold !==
			(receipt.schemaVersion === "tedix.product-keyframe-gate.v1"
				? 90
				: PRODUCT_KEYFRAME_FIDELITY_THRESHOLD)
	)
		throw new Error("keyframe fidelity receipt does not match the endpoint");
	const index = Number(metadata.candidateIndex);
	const candidate = receipt.candidates.find((item) => item.index === index);
	if (
		!receipt.approvedCandidateIndexes.includes(index) ||
		!candidate ||
		candidate.fidelityStatus !== "approved" ||
		candidate.productFidelityScore < receipt.approvalThreshold ||
		candidate.r2Key !== frameR2Key ||
		candidate.sha256 !== frameSha256
	)
		throw new Error(
			"keyframe endpoint is not admitted by its fidelity receipt",
		);
}

export interface KeyframeGateReceipt {
	schemaVersion:
		| "tedix.product-keyframe-gate.v1"
		| "tedix.product-keyframe-gate.v2";
	gateId: string;
	organizationId: string;
	productContextSha256: string;
	referenceSha256s: string[];
	judgeModel: "gemini-2.5-pro";
	approvalThreshold: number;
	approvedCandidateIndexes: number[];
	candidates: Array<{
		index: number;
		r2Key: string;
		sha256: string;
		mimeType: string;
		fidelityStatus: "approved" | "rejected";
		productFidelityScore: number;
	}>;
	createdAt: string;
}

export function assertApprovedKeyframePair(
	organizationId: string,
	firstFrameR2Key: string,
	lastFrameR2Key: string,
	firstMetadata: Record<string, string> | undefined,
	lastMetadata: Record<string, string> | undefined,
	receipt: KeyframeGateReceipt,
	receiptSha256: string,
	expectedProductContextSha256: string,
	firstSha256: string,
	lastSha256: string,
): void {
	if (firstFrameR2Key === lastFrameR2Key)
		throw new Error("distinct approved keyframe endpoints required");
	if (firstMetadata?.gateId !== lastMetadata?.gateId)
		throw new Error("keyframe endpoints must belong to the same fidelity gate");
	assertApprovedKeyframe(
		organizationId,
		firstFrameR2Key,
		firstMetadata,
		receipt,
		receiptSha256,
		expectedProductContextSha256,
		firstSha256,
	);
	assertApprovedKeyframe(
		organizationId,
		lastFrameR2Key,
		lastMetadata,
		receipt,
		receiptSha256,
		expectedProductContextSha256,
		lastSha256,
	);
}

export function parseAndEnforceKeyframeJudgment(
	response: unknown,
	candidateCount: number,
): KeyframeJudgment {
	const parts = (
		response as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		}
	)?.candidates?.[0]?.content?.parts;
	const text = parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();
	if (!text) throw new Error("Vertex keyframe judge returned no verdict");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Vertex keyframe judge returned malformed JSON");
	}
	const value = parsed as Partial<KeyframeJudgment>;
	if (
		!Array.isArray(value.candidates) ||
		value.candidates.length !== candidateCount ||
		typeof value.summary !== "string"
	) {
		throw new Error(
			"Vertex keyframe judge verdict failed structural validation",
		);
	}
	const candidates = value.candidates.map((candidate, index) => {
		if (
			candidate.index !== index ||
			!["pass", "reject"].includes(candidate.verdict) ||
			!Number.isInteger(candidate.productFidelityScore) ||
			candidate.productFidelityScore < 0 ||
			candidate.productFidelityScore > 100 ||
			!Array.isArray(candidate.findings) ||
			candidate.findings.some((finding) => typeof finding !== "string")
		) {
			throw new Error(
				`Vertex keyframe judge candidate ${index} failed structural validation`,
			);
		}
		return candidate;
	});
	const approvedCandidateIndexes = candidates
		.filter(
			(candidate) =>
				candidate.verdict === "pass" &&
				candidate.productFidelityScore >= PRODUCT_KEYFRAME_FIDELITY_THRESHOLD &&
				candidate.findings.length === 0,
		)
		.map((candidate) => candidate.index);
	return { approvedCandidateIndexes, candidates, summary: value.summary };
}
