import { describe, expect, it } from "vite-plus/test";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import preset from "./agent-surface-assurance.fixture.json";
import { factoryUpgradeBlockers } from "./os-blueprint-upgrade";

describe("factory revision migration", () => {
	it("preserves existing non-factory and identical factory upgrades", () => {
		const plain = OsBlueprintDefinitionSchema.parse({});
		const factory = OsBlueprintDefinitionSchema.parse(preset);
		expect(factoryUpgradeBlockers(plain, plain)).toEqual([]);
		expect(factoryUpgradeBlockers(factory, structuredClone(factory))).toEqual(
			[],
		);
	});
	it("does not silently migrate a changed, added, or removed operating contract", () => {
		const plain = OsBlueprintDefinitionSchema.parse({});
		const original = OsBlueprintDefinitionSchema.parse(preset);
		const changed = structuredClone(original);
		changed.factory!.limits.maxAttemptsPerCycle = 3;
		for (const [left, right] of [
			[original, changed],
			[plain, original],
			[original, plain],
		] as const) {
			expect(factoryUpgradeBlockers(left, right)).toEqual([
				expect.stringContaining("Certify a new pinned Workspace"),
			]);
		}
	});
});
