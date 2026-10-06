import { describe, expect, it } from "vite-plus/test";
import {
	initialModelRef,
	modelsForNewSelection,
	modelsForSettings,
} from "./model-selection";

const models = [
	{ ref: "active/allowed", allowed: true, selectable: true },
	{ ref: "active/denied", allowed: false, selectable: true },
	{ ref: "old/allowed", allowed: true, selectable: false },
	{ ref: "old/denied", allowed: false, selectable: false },
] as const;

describe("model picker lifecycle", () => {
	it("keeps policy denials visible but removes superseded refs from new choices", () => {
		expect(modelsForNewSelection(models).map((model) => model.ref)).toEqual([
			"active/allowed",
			"active/denied",
		]);
	});

	it("preserves an allowed routed superseded ref", () => {
		expect(initialModelRef(models, "old/allowed")).toBe("old/allowed");
	});

	it("never seeds a denied or superseded fallback", () => {
		expect(initialModelRef(models, "old/denied")).toBe("active/allowed");
		expect(
			initialModelRef(
				models.filter((model) => model.ref !== "active/allowed"),
				null,
			),
		).toBeNull();
	});

	it("retains only the current superseded ref in settings", () => {
		expect(
			modelsForSettings(models, "old/allowed").map((model) => model.ref),
		).toEqual(["active/allowed", "active/denied", "old/allowed"]);
	});
});
