import { describe, expect, it } from "vite-plus/test";
import {
	OsBlueprintDefinitionSchema,
	parseStoredOsBlueprintDefinition,
} from "@tedix/api-contract/schemas/os-workspaces";
import preset from "./agent-surface-assurance.fixture.json";

/** A factory revision as stored before 2026-09-10: each contract carried `claims[]`. */
function legacyStoredRevision(): string {
	const stored = structuredClone(preset);
	for (const template of stored.factory.templates) {
		Object.assign(template.acceptanceContract, {
			claims: [
				{
					key: "fictional_claim",
					label: "A fictional reviewed claim",
					minimumAcceptedEvidence: 1,
					evidenceKinds: [],
					requiresIndependentReview: true,
				},
			],
		});
	}
	return JSON.stringify(stored);
}

describe("parseStoredOsBlueprintDefinition", () => {
	it("reads a revision stored with the retired claims[] contract shape", () => {
		const text = legacyStoredRevision();
		// The strict schema is what failed live for these revisions.
		expect(() => OsBlueprintDefinitionSchema.parse(JSON.parse(text))).toThrow(
			/Unrecognized key: \\"claims\\"/,
		);
		const definition = parseStoredOsBlueprintDefinition(text);
		expect(definition).toEqual(OsBlueprintDefinitionSchema.parse(preset));
	});

	it("still rejects any other unknown contract key", () => {
		const stored = structuredClone(preset);
		Object.assign(stored.factory.templates[0].acceptanceContract, {
			reviewer: "fictional",
		});
		expect(() =>
			parseStoredOsBlueprintDefinition(JSON.stringify(stored)),
		).toThrow(/Unrecognized key: \\"reviewer\\"/);
	});

	it("reads plain revisions unchanged", () => {
		expect(parseStoredOsBlueprintDefinition("{}")).toEqual(
			OsBlueprintDefinitionSchema.parse({}),
		);
	});
});
