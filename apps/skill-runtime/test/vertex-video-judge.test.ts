import { describe, expect, test } from "bun:test";
import {
	extractJudgeJson,
	isOrganizationOwnedJudgeVideoKey,
	validateReferenceImages,
	videoJudgePrompt,
} from "../src/vertex-video-judge";

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
