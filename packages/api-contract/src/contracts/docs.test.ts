import { describe, expect, it } from "vite-plus/test";
import { procedureOutputSchema } from "../utils/procedure-schemas";
import { zodToStructuredOutputJsonSchema } from "../utils/tool-json-schema";
import { docsContract } from "./docs";

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
