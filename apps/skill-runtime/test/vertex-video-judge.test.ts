import { describe, expect, test } from "bun:test";
import {
	extractJudgeJson,
	isOrganizationOwnedJudgeVideoKey,
	MAX_REFERENCE_IMAGE_BYTES,
	validateReferenceImages,
	videoJudgePrompt,
} from "../src/vertex-video-judge";

function base64WithDecodedBytes(bytes: number): string {
	const completeGroups = Math.floor(bytes / 3);
	const remainder = bytes % 3;
	return (
		"AAAA".repeat(completeGroups) +
		(remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "")
	);
}

describe("Vertex video judge", () => {
	test("admits organization-owned render outputs and approved source footage", () => {
		expect(
			isOrganizationOwnedJudgeVideoKey(
				"video-renders/org-1/render-1/output.mp4",
				"org-1",
			),
		).toBe(true);
		expect(
			isOrganizationOwnedJudgeVideoKey(
				"video-assets/org-1/manufacturer-footage/808252/walkaround.mp4",
				"org-1",
			),
		).toBe(true);
		expect(
			isOrganizationOwnedJudgeVideoKey(
				"video-assets/org-2/manufacturer-footage/808252/walkaround.mp4",
				"org-1",
			),
		).toBe(false);
		expect(
			isOrganizationOwnedJudgeVideoKey(
				"video-assets/org-1/reference.webp",
				"org-1",
			),
		).toBe(false);
	});

	test("builds a conservative motion and fidelity rubric", () => {
		const prompt = videoJudgePrompt({ productContext: "green Cube bicycle" });
		expect(prompt).toContain(
			"pan or zoom over a static image is not product motion",
		);
		expect(prompt).toContain(
			"product geometry/colour/component/branding fidelity",
		);
		expect(prompt).toContain("green Cube bicycle");
	});

	test("bounds and validates inline product references", () => {
		expect(
			validateReferenceImages([{ mimeType: "image/jpeg", data: "YQ==" }]),
		).toHaveLength(1);
		expect(() =>
			validateReferenceImages([{ mimeType: "image/svg+xml", data: "YQ==" }]),
		).toThrow("unsupported mime type");
	});

	test("rejects malformed base64", () => {
		for (const data of ["A==", "AAA", "=AAA", "AA=A", "A==="]) {
			expect(() =>
				validateReferenceImages([{ mimeType: "image/png", data }]),
			).toThrow("not valid base64");
		}
	});

	test("counts base64 padding in the decoded byte limit", () => {
		expect(
			validateReferenceImages([
				{
					mimeType: "image/webp",
					data: base64WithDecodedBytes(MAX_REFERENCE_IMAGE_BYTES),
				},
			]),
		).toHaveLength(1);
		expect(() =>
			validateReferenceImages([
				{
					mimeType: "image/webp",
					data: base64WithDecodedBytes(MAX_REFERENCE_IMAGE_BYTES + 1),
				},
			]),
		).toThrow(`must be 1-${MAX_REFERENCE_IMAGE_BYTES} bytes`);
	});

	test("extracts the structured JSON verdict", () => {
		expect(
			extractJudgeJson({
				candidates: [
					{ content: { parts: [{ text: '{"verdict":"revise"}' }] } },
				],
			}),
		).toEqual({ verdict: "revise" });
		expect(() => extractJudgeJson({ candidates: [] })).toThrow(
			"no text verdict",
		);
	});
});
