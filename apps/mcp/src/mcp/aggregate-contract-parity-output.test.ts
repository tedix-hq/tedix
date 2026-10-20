import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { zodToStructuredOutputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { describe, expect, it } from "vite-plus/test";
import { validateStructuredContentAgainstOutputSchema } from "./utils/schema";

// Raw handler output shapes: projects.ts renames status to disposition;
// work-items/creation-reads.ts projects relation rows to these five fields.
// Fixtures are deliberately not contract-parsed before MCP validation.
const fixtures = [
	{
		endpoint: "projects/getRollup",
		output: {
			projectId: "project-1",
			total: 1,
			byDisposition: { accepted: 1 },
			byWorkKind: { coding: 1 },
			percentDone: 0,
			aggregateDisposition: "accepted",
			distinctExecutors: [],
			topLevelItems: [
				{
					id: "work-1",
					workKind: "coding",
					title: "Fix schema",
					disposition: "accepted",
				},
			],
			truncated: false,
		},
	},
	{
		endpoint: "workItems/listRelations",
		output: {
			relations: [
				{
					id: "relation-1",
					fromWorkItemId: "work-1",
					toWorkItemId: "work-2",
					relationType: "blocks",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			truncated: false,
		},
	},
];

describe("aggregate contract parity for raw router outputs", () => {
	it.each(fixtures)(
		"validates $endpoint with a closed object schema",
		({ endpoint, output }) => {
			const resolved = resolveContractEndpoint(endpoint);
			expect(resolved).not.toBeNull();
			const schema = zodToStructuredOutputJsonSchema(resolved?.outputSchema);
			expect(schema).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(() =>
				validateStructuredContentAgainstOutputSchema(schema, output, endpoint),
			).not.toThrow();
			expect(() =>
				validateStructuredContentAgainstOutputSchema(
					schema,
					{ ...output, undeclared: true },
					endpoint,
				),
			).toThrow(/outputSchema/);
			const nestedOutput = output.topLevelItems
				? {
						...output,
						topLevelItems: output.topLevelItems.map((item) => ({
							...item,
							undeclared: true,
						})),
					}
				: {
						...output,
						relations: output.relations.map((edge) => ({
							...edge,
							orgId: "org-1",
							metadata: {},
						})),
					};
			expect(() =>
				validateStructuredContentAgainstOutputSchema(
					schema,
					nestedOutput,
					endpoint,
				),
			).toThrow(/outputSchema/);
		},
	);
});
