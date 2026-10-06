import { describe, expect, test } from "bun:test";
import {
	assertApprovedKeyframe,
	assertApprovedKeyframePair,
	extractGeminiKeyframe,
	geminiProductKeyframeRequest,
	keyframeJudgePrompt,
	parseAndEnforceKeyframeJudgment,
	PRODUCT_KEYFRAME_FIDELITY_THRESHOLD,
	validateProductKeyframeRequest,
	validateVeoAssetReferenceRequest,
	validateVeoBackgroundRequest,
	veoAssetReferenceRequest,
	veoBackgroundRequest,
} from "../src/vertex-product-keyframes";

const reference = { mimeType: "image/jpeg", data: "YQ==" };

describe("Vertex product keyframe gate", () => {
	test("uses the perceptual identity threshold for generated keyframes", () => {
		expect(PRODUCT_KEYFRAME_FIDELITY_THRESHOLD).toBe(85);
		expect(keyframeJudgePrompt("approved bicycle", 3)).toContain(
			"passing candidate, return an empty findings array",
		);
	});
	const approvedMetadata = (gateId: string, candidateIndex: number) => ({
		kind: "product-keyframe",
		gateId,
		candidateIndex: String(candidateIndex),
		fidelityStatus: "approved",
		productFidelityScore: "95",
		judgeModel: "gemini-2.5-pro",
		receiptSha256: "receipt-hash",
	});
	const receipt = {
		schemaVersion: "tedix.product-keyframe-gate.v1" as const,
		gateId: "gate",
		organizationId: "org",
		productContextSha256: "product-hash",
		referenceSha256s: ["reference-hash"],
		judgeModel: "gemini-2.5-pro" as const,
		approvalThreshold: 90 as const,
		approvedCandidateIndexes: [0, 1],
		candidates: [0, 1].map((index) => ({
			index,
			r2Key: `video-keyframes/org/gate/${index}.png`,
			sha256: `candidate-${index}-hash`,
			mimeType: "image/png",
			fidelityStatus: "approved" as const,
			productFidelityScore: 95,
		})),
		createdAt: "2026-08-22T00:00:00.000Z",
	};

	test("uses approved references for Gemini image generation", () => {
		const input = validateProductKeyframeRequest({
			productContext: "approved bicycle",
			prompt: "riding on a forest path",
			referenceImages: [reference, reference],
			sampleCount: 2,
		});
		const body = geminiProductKeyframeRequest(input) as {
			contents: Array<{ parts: Array<{ inlineData?: unknown }> }>;
		};
		expect(
			body.contents[0].parts.filter((part) => part.inlineData),
		).toHaveLength(2);
	});

	test("defaults keyframes to 16:9 for existing callers", () => {
		const input = validateProductKeyframeRequest({
			productContext: "approved bicycle",
			prompt: "on a forest path",
			referenceImages: [reference],
		});
		expect(input.aspectRatio).toBe("16:9");
		const body = geminiProductKeyframeRequest(input) as {
			generationConfig: { imageConfig: { aspectRatio: string } };
		};
		expect(body.generationConfig.imageConfig.aspectRatio).toBe("16:9");
	});

	test("generates vertical keyframes when 9:16 is requested", () => {
		// Veo pillarboxes a 16:9 source frame into a 9:16 canvas instead of
		// reframing it, so a vertical clip is only possible when the keyframe
		// itself is vertical.
		const input = validateProductKeyframeRequest({
			productContext: "approved bicycle",
			prompt: "on a forest path",
			referenceImages: [reference],
			aspectRatio: "9:16",
		});
		const body = geminiProductKeyframeRequest(input) as {
			generationConfig: { imageConfig: { aspectRatio: string } };
			contents: Array<{ parts: Array<{ text?: string }> }>;
		};
		expect(body.generationConfig.imageConfig.aspectRatio).toBe("9:16");
		expect(body.contents[0].parts[0]?.text).toContain("photorealistic 9:16");
	});

	test("rejects an unsupported keyframe aspect ratio", () => {
		expect(() =>
			validateProductKeyframeRequest({
				productContext: "approved bicycle",
				prompt: "on a forest path",
				referenceImages: [reference],
				aspectRatio: "1:1",
			}),
		).toThrow(/aspectRatio must be 16:9 or 9:16/);
	});

	test("extracts an inline Gemini image", () => {
		expect(
			extractGeminiKeyframe(
				{
					candidates: [
						{
							content: {
								parts: [
									{
										inlineData: {
											mimeType: "image/png",
											data: "YQ==",
										},
									},
								],
							},
						},
					],
				},
				0,
			),
		).toMatchObject({ mimeType: "image/png", data: "YQ==" });
	});

	test("admits only candidates that pass the configured fidelity floor", () => {
		const response = {
			candidates: [
				{
					content: {
						parts: [
							{
								text: JSON.stringify({
									approvedCandidateIndexes: [0, 1],
									summary: "mixed",
									candidates: [
										{
											index: 0,
											verdict: "pass",
											productFidelityScore: 95,
											findings: [],
										},
										{
											index: 1,
											verdict: "pass",
											productFidelityScore: 84,
											findings: [],
										},
									],
								}),
							},
						],
					},
				},
			],
		};
		const result = parseAndEnforceKeyframeJudgment(response, 2);
		expect(result.approvedCandidateIndexes).toEqual([0]);
	});

	test("admits only two distinct approved endpoints from the same gate", () => {
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate/0.png",
				"video-keyframes/org/gate/1.png",
				approvedMetadata("gate", 0),
				approvedMetadata("gate", 1),
				receipt,
				"receipt-hash",
				"product-hash",
				"candidate-0-hash",
				"candidate-1-hash",
			),
		).not.toThrow();
	});

	test("admits one sealed high-fidelity keyframe for image-to-video", () => {
		expect(() =>
			assertApprovedKeyframe(
				"org",
				"video-keyframes/org/gate/0.png",
				approvedMetadata("gate", 0),
				receipt,
				"receipt-hash",
				"product-hash",
				"candidate-0-hash",
			),
		).not.toThrow();
	});

	test("rejects rejected, cross-gate, and duplicate keyframe endpoints", () => {
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate/0.png",
				"video-keyframes/org/gate/1.png",
				{ ...approvedMetadata("gate", 0), fidelityStatus: "rejected" },
				approvedMetadata("gate", 1),
				receipt,
				"receipt-hash",
				"product-hash",
				"candidate-0-hash",
				"candidate-1-hash",
			),
		).toThrow("fidelity approval");
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate-a/0.png",
				"video-keyframes/org/gate-b/1.png",
				approvedMetadata("gate-a", 0),
				approvedMetadata("gate-b", 1),
				receipt,
				"receipt-hash",
				"product-hash",
				"candidate-0-hash",
				"candidate-1-hash",
			),
		).toThrow("same fidelity gate");
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate/0.png",
				"video-keyframes/org/gate/0.png",
				approvedMetadata("gate", 0),
				approvedMetadata("gate", 0),
				receipt,
				"receipt-hash",
				"product-hash",
				"candidate-0-hash",
				"candidate-0-hash",
			),
		).toThrow("distinct approved keyframe endpoints");
	});

	test("rejects endpoint bytes that diverge from the sealed receipt", () => {
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate/0.png",
				"video-keyframes/org/gate/1.png",
				approvedMetadata("gate", 0),
				approvedMetadata("gate", 1),
				receipt,
				"receipt-hash",
				"product-hash",
				"mutated-hash",
				"candidate-1-hash",
			),
		).toThrow("not admitted by its fidelity receipt");
	});

	test("rejects replaying an approved gate for another product", () => {
		expect(() =>
			assertApprovedKeyframePair(
				"org",
				"video-keyframes/org/gate/0.png",
				"video-keyframes/org/gate/1.png",
				approvedMetadata("gate", 0),
				approvedMetadata("gate", 1),
				receipt,
				"receipt-hash",
				"different-product-hash",
				"candidate-0-hash",
				"candidate-1-hash",
			),
		).toThrow("receipt does not match");
	});

	test("rejects malformed or incomplete judge output", () => {
		expect(() =>
			parseAndEnforceKeyframeJudgment(
				{ candidates: [{ content: { parts: [{ text: "{}" }] } }] },
				2,
			),
		).toThrow("structural validation");
	});

	test("builds a bounded Veo asset-reference request", () => {
		const input = validateVeoAssetReferenceRequest({
			model: "veo-3.1-generate-001",
			prompt: "The exact approved bicycle rides through a forest.",
			referenceImages: [reference, reference, reference],
		});
		const body = veoAssetReferenceRequest(input) as {
			instances: Array<{
				referenceImages: Array<{ referenceType: string }>;
			}>;
			parameters: { durationSeconds: number };
		};
		expect(body.instances[0].referenceImages).toHaveLength(3);
		expect(
			body.instances[0].referenceImages.every(
				(image) => image.referenceType === "asset",
			),
		).toBe(true);
		expect(body.parameters.durationSeconds).toBe(8);
	});

	test("rejects too many asset references and non-eight-second requests", () => {
		expect(() =>
			validateVeoAssetReferenceRequest({
				model: "veo-3.1-generate-001",
				prompt: "product motion",
				referenceImages: [reference, reference, reference, reference],
			}),
		).toThrow("1-3");
		expect(() =>
			validateVeoAssetReferenceRequest({
				model: "veo-3.1-generate-001",
				prompt: "product motion",
				referenceImages: [reference],
				durationSeconds: 4,
			}),
		).toThrow("requires 8 seconds");
	});

	test("builds a product-free Veo background request", () => {
		const input = validateVeoBackgroundRequest({
			model: "veo-3.1-generate-001",
			prompt:
				"Empty forest trail, low tracking camera, no bicycle, rider, vehicle, product, text, or logo.",
		});
		expect(veoBackgroundRequest(input)).toEqual({
			instances: [{ prompt: input.prompt }],
			parameters: {
				aspectRatio: "16:9",
				sampleCount: 1,
				durationSeconds: 8,
			},
		});
	});
});
