import { describe, expect, it } from "vite-plus/test";
import { continuesOutputAutosaveBurst } from "./os-output-autosave";
import { OS_OUTPUT_AUTOSAVE_NOTE } from "./os-output-limits";
const previous = {
	note: OS_OUTPUT_AUTOSAVE_NOTE,
	createdByKind: "user",
	createdById: "u1",
	skillRunId: null,
	createdAt: "2026-11-11T12:00:00Z",
};
const current = { ...previous, createdAt: "2026-11-11T12:01:00Z" };
describe("output auto-save bursts", () => {
	it("groups the same person's consecutive auto-saves", () =>
		expect(continuesOutputAutosaveBurst(previous, current)).toBe(true));
	it.each([
		{ createdAt: "2026-11-11T12:03:00Z" },
		{ createdAt: "2026-11-11T11:59:00Z" },
		{ createdById: "u2" },
		{ createdByKind: "tedi" },
		{ skillRunId: "run" },
		{ note: "Named version" },
	])("starts a new burst for %j", (patch) =>
		expect(
			continuesOutputAutosaveBurst(previous, { ...current, ...patch }),
		).toBe(false),
	);
	it("starts after a manual save or absent predecessor", () => {
		expect(
			continuesOutputAutosaveBurst(
				{ ...previous, note: "Named version" },
				current,
			),
		).toBe(false);
		expect(continuesOutputAutosaveBurst(undefined, current)).toBe(false);
	});
});
