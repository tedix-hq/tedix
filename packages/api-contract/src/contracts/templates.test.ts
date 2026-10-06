import { describe, expect, it } from "vite-plus/test";
import {
	ApplyTemplateInputSchema,
	CreateTemplateInputSchema,
	UpdateTemplateInputSchema,
	TemplateResponseSchema,
} from "./templates";
import {
	AppMetadataSchema,
	CreateAppInputSchema,
	UpdateAppInputSchema,
} from "../schemas/app";
const extractionConfig = {
	method: "agent",
	arrayKey: "items",
	siteName: "Example",
	siteContext: "Context",
	siteSearchInstructions: "Browse",
	prompt: "Extract",
	schema: { type: "object" },
};
const apply = {
	templateId: crypto.randomUUID(),
	organizationId: crypto.randomUUID(),
	name: "Example",
	slug: "example",
	primaryDomain: "example.com",
};
describe("strict extraction contract boundaries", () => {
	it("rejects unsupported settings across app and template write/read contracts", () => {
		const invalid = { ...extractionConfig, currency: "EUR" };
		for (const config of [extractionConfig, invalid]) {
			const valid = config === extractionConfig;
			expect(
				CreateAppInputSchema.safeParse({
					name: "Example",
					metadata: { extractionConfig: config },
				}).success,
			).toBe(valid);
			expect(
				UpdateAppInputSchema.safeParse({
					appId: crypto.randomUUID(),
					metadata: { extractionConfig: config },
				}).success,
			).toBe(valid);
			expect(
				AppMetadataSchema.safeParse({ extractionConfig: config }).success,
			).toBe(valid);
			expect(
				CreateTemplateInputSchema.safeParse({
					name: "Example",
					slug: "example",
					vertical: "ecommerce",
					extractionConfig: config,
				}).success,
			).toBe(valid);
			expect(
				UpdateTemplateInputSchema.safeParse({
					templateId: apply.templateId,
					extractionConfig: config,
				}).success,
			).toBe(valid);
			expect(
				TemplateResponseSchema.safeParse({
					id: apply.templateId,
					name: "Example",
					slug: "example",
					description: null,
					vertical: "ecommerce",
					version: 1,
					isActive: true,
					createdAt: null,
					updatedAt: null,
					extractionConfig: config,
				}).success,
			).toBe(valid);
		}
	});
	it("closes generic metadata overrides while retaining unrelated metadata", () => {
		const input = {
			...apply,
			metadataOverrides: { custom: { flag: true }, extractionConfig },
		};
		expect(ApplyTemplateInputSchema.parse(input)).toEqual(input);
		const invalid = {
			...input,
			metadataOverrides: {
				extractionConfig: { ...extractionConfig, enabled: true },
			},
		};
		const parsed = ApplyTemplateInputSchema.safeParse(invalid);
		expect(parsed.success).toBe(false);
		if (!parsed.success)
			expect(parsed.error.issues[0]?.path).toEqual([
				"metadataOverrides",
				"extractionConfig",
			]);
		expect(
			ApplyTemplateInputSchema.safeParse({
				...apply,
				extractionConfigOverrides: { enabled: true },
			}).success,
		).toBe(false);
		expect(
			ApplyTemplateInputSchema.parse({
				...apply,
				extractionConfigOverrides: { siteContext: "Updated" },
			}).extractionConfigOverrides,
		).toEqual({ siteContext: "Updated" });
	});
});
