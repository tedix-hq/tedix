import { expect, it } from "vite-plus/test";
import {
	PersonalAgentIdentitySchema,
	WorkContributionSourceSchema,
} from "./os-work-actor";

it("validates governed identity configuration and rejects unsafe assets", () => {
	expect(
		PersonalAgentIdentitySchema.parse({
			version: 1,
			representedUserId: "morgan",
		}),
	).toEqual({ version: 1, representedUserId: "morgan" });
	for (const imageUrl of [
		"javascript:alert(1)",
		"data:image/svg+xml,<svg/>",
		"http://example.test/logo.png",
	])
		expect(
			PersonalAgentIdentitySchema.safeParse({
				version: 1,
				representedUserId: "morgan",
				imageUrl,
			}).success,
		).toBe(false);
});

it("keeps source evidence bounded and non-executable", () => {
	const source = {
		channel: "Browser form",
		capturedAt: "2026-10-19T10:00:00.000Z",
		externalFindingId: "sample-1",
	};
	for (const evidenceUrl of [
		"/work/items/sample",
		"https://example.test/evidence",
	])
		expect(
			WorkContributionSourceSchema.safeParse({ ...source, evidenceUrl })
				.success,
		).toBe(true);
	for (const evidenceUrl of [
		"//example.test",
		"/\\example.test",
		"javascript:alert(1)",
		"https://example.test/ bad",
	])
		expect(
			WorkContributionSourceSchema.safeParse({ ...source, evidenceUrl })
				.success,
		).toBe(false);
});
