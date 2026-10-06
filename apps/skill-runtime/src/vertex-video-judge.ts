export const MAX_JUDGE_VIDEO_BYTES = 20_000_000;
export const MAX_REFERENCE_IMAGES = 4;
export const MAX_REFERENCE_IMAGE_BYTES = 4_000_000;

export interface InlineReferenceImage {
	mimeType: string;
	data: string;
	label?: string;
}

export interface VideoJudgeInput {
	productContext: string;
	rubric?: string;
	referenceImages?: InlineReferenceImage[];
}

export function isOrganizationOwnedJudgeVideoKey(
	r2Key: string,
	organizationId: string,
): boolean {
	if (!organizationId || !r2Key.endsWith(".mp4")) return false;
	return [
		`video-renders/${organizationId}/`,
		`video-assets/${organizationId}/`,
	].some((prefix) => r2Key.startsWith(prefix));
}

export function validateReferenceImages(
	images: InlineReferenceImage[] | undefined,
): InlineReferenceImage[] {
	if (!images) return [];
	if (images.length > MAX_REFERENCE_IMAGES) {
		throw new Error(`at most ${MAX_REFERENCE_IMAGES} reference images allowed`);
	}
	return images.map((image, index) => {
		if (!/^image\/(jpeg|png|webp)$/.test(image.mimeType)) {
			throw new Error(`reference image ${index + 1} has unsupported mime type`);
		}
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
			throw new Error(`reference image ${index + 1} is not valid base64`);
		}
		const decodedBytes = Math.floor((image.data.length * 3) / 4);
		if (decodedBytes < 1 || decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
			throw new Error(
				`reference image ${index + 1} must be 1-${MAX_REFERENCE_IMAGE_BYTES} bytes`,
			);
		}
		return image;
	});
}

export function videoJudgePrompt(input: VideoJudgeInput): string {
	return [
		"You are an independent ecommerce promotional-video quality judge.",
		"Watch the entire candidate video and compare it with every supplied product reference image.",
		"Judge only visible evidence. Do not infer product features or excuse generative artifacts.",
		"Inspect temporal continuity, real physical and camera movement, product geometry/colour/component/branding fidelity, scene usefulness, promotional engagement, text/claim compliance, and edit continuity.",
		"A pan or zoom over a static image is not product motion. Morphing, teleporting parts, frozen subjects, and inconsistent product identity are defects.",
		"For every defect, provide a timestamp or timestamp range, concrete visible evidence, severity, and a correction instruction suitable for the next generation prompt or renderer pass.",
		"Return a conservative pass verdict: pass only when no high or critical defect remains.",
		`Product context: ${input.productContext}`,
		input.rubric ? `Additional rubric: ${input.rubric}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export const videoJudgeResponseSchema = {
	type: "OBJECT",
	properties: {
		verdict: { type: "STRING", enum: ["pass", "revise", "reject"] },
		overallScore: { type: "INTEGER", minimum: 0, maximum: 100 },
		summary: { type: "STRING" },
		scores: {
			type: "OBJECT",
			properties: {
				motion: { type: "INTEGER", minimum: 0, maximum: 100 },
				productFidelity: { type: "INTEGER", minimum: 0, maximum: 100 },
				engagement: { type: "INTEGER", minimum: 0, maximum: 100 },
				continuity: { type: "INTEGER", minimum: 0, maximum: 100 },
				compliance: { type: "INTEGER", minimum: 0, maximum: 100 },
			},
			required: [
				"motion",
				"productFidelity",
				"engagement",
				"continuity",
				"compliance",
			],
		},
		findings: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					category: {
						type: "STRING",
						enum: [
							"motion",
							"product_fidelity",
							"engagement",
							"continuity",
							"compliance",
						],
					},
					severity: {
						type: "STRING",
						enum: ["low", "medium", "high", "critical"],
					},
					timestamp: { type: "STRING" },
					evidence: { type: "STRING" },
					correction: { type: "STRING" },
				},
				required: [
					"category",
					"severity",
					"timestamp",
					"evidence",
					"correction",
				],
			},
		},
		correctionBrief: { type: "STRING" },
	},
	required: [
		"verdict",
		"overallScore",
		"summary",
		"scores",
		"findings",
		"correctionBrief",
	],
} as const;

export function extractJudgeJson(response: unknown): unknown {
	const body = response as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
	};
	const text = body.candidates?.[0]?.content?.parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();
	if (!text) throw new Error("Vertex judge returned no text verdict");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Vertex judge returned malformed JSON");
	}
}
