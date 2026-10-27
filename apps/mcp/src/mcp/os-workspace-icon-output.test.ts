import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { zodToStructuredOutputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { describe, expect, it } from "vite-plus/test";
import { validateStructuredContentAgainstOutputSchema } from "./utils/schema";

// The raw router row (os-workspaces-shared.ts mapWorkspace), not contract-parsed.
const workspace = {
	id: "0b90b0e2-14da-4a34-bd35-a416ab604f25",
	organizationId: "org-fictional",
	name: "Research",
	description: null,
	status: "active",
	sourceBlueprintId: null,
	sourceBlueprintRevisionId: null,
	sourceBlueprintRevisionNumber: null,
	instantiationPreflight: null,
	rollbackReference: null,
	blueprintDecision: null,
	createdByKind: "user",
	createdById: "member-robin",
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	visibility: "org",
	ownerUserId: null,
};

const variants = [
	["without an icon", { ...workspace, iconUrl: null }],
	[
		"with an icon",
		{
			...workspace,
			iconUrl: "https://imagedelivery.net/hash/0000000000000000/public",
		},
	],
	["from a row that predates icons", workspace],
] as const;

describe("workspace tool outputs carry the optional icon", () => {
	it.each(
		variants.flatMap(([label, row]) => [
			[
				"osWorkspaces/workspaces/list",
				label,
				{ items: [row], truncated: false },
			],
			["osWorkspaces/workspaces/get", label, { workspace: row }],
			["osWorkspaces/workspaces/setIcon", label, { workspace: row }],
			["osWorkspaces/workspaces/removeIcon", label, { workspace: row }],
		]),
	)("%s validates %s", (endpoint, _label, output) => {
		const schema = zodToStructuredOutputJsonSchema(
			resolveContractEndpoint(endpoint)?.outputSchema,
		);
		expect(schema).not.toBeNull();
		expect(() =>
			validateStructuredContentAgainstOutputSchema(schema, output, endpoint),
		).not.toThrow();
	});
});
