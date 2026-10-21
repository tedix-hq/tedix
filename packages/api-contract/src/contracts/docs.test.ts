import { describe, expect, it } from "vite-plus/test";
import { procedureOutputSchema } from "../utils/procedure-schemas";
import { zodToStructuredOutputJsonSchema } from "../utils/tool-json-schema";
import {
	DocsReleaseResultSchema,
	DocsSearchProjectionSchema,
	docsContract,
} from "./docs";

describe("Docs MCP output contracts", () => {
	it.each([
		["publishBuild", docsContract.publishBuild],
		["rollbackBuild", docsContract.rollbackBuild],
	])("projects %s as a typed release result", (_name, procedure) => {
		const schema = zodToStructuredOutputJsonSchema(
			procedureOutputSchema(procedure),
		);

		expect(schema).toMatchObject({
			type: "object",
			required: ["site", "release", "searchProjection"],
			properties: {
				site: { type: "object" },
				release: { type: "object" },
				searchProjection: { anyOf: expect.any(Array) },
			},
		});
	});

	it.each([
		{ status: "queued", workflowId: "search-release" },
		{ status: "failed", error: "Workflow unavailable" },
		null,
	])("accepts the Docs Worker's search projection receipt %j", (projection) => {
		expect(DocsSearchProjectionSchema.safeParse(projection).success).toBe(true);
	});

	it.each([
		{ status: "queued", workflowId: "search-release" },
		{ status: "failed", error: "Workflow unavailable" },
		null,
	])("accepts a whole publish receipt with projection %j", (projection) => {
		const id = "11111111-1111-4111-8111-111111111111";
		const actor = { type: "external_agent", id: "agent", sessionId: null };
		const receipt = {
			site: {
				id,
				orgSlug: "acme",
				slug: "docs",
				title: "Docs",
				description: "Docs",
				locale: "en",
				canonicalUrl: "https://docs.example.test",
				sourceProvider: "artifacts",
				sourceAuthMode: "public",
				repositoryUrl: null,
				artifactsRepository: null,
				branch: "main",
				contentRoot: "docs/public",
				accessMode: "public",
				status: "active",
				activeBuildId: id,
				latestBuildId: id,
				createdAt: "2026-10-21T00:00:00.000Z",
				updatedAt: "2026-10-21T00:00:00.000Z",
			},
			release: {
				id,
				siteId: id,
				buildId: id,
				previousBuildId: null,
				action: "publish",
				actor,
				createdAt: "2026-10-21T00:00:00.000Z",
			},
			searchProjection: projection,
		};
		expect(DocsReleaseResultSchema.safeParse(receipt).success).toBe(true);
	});

	it("projects validation as the two concrete runtime result variants", () => {
		const schema = zodToStructuredOutputJsonSchema(
			procedureOutputSchema(docsContract.validateChange),
		);

		expect(schema?.anyOf).toHaveLength(2);
		expect(schema?.anyOf).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "object",
					required: ["change", "build", "idempotent"],
				}),
				expect.objectContaining({
					type: "object",
					required: ["build", "previewPath", "workflowId", "change"],
				}),
			]),
		);
	});
});
