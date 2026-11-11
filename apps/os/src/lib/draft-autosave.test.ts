import { describe, expect, it } from "vite-plus/test";
import {
	AUTOSAVE_IDLE_MS,
	AUTOSAVE_MIN_INTERVAL_MS,
	autosaveDelay,
} from "./draft-autosave";

describe("autosaveDelay", () => {
	it("waits for the idle period after the last local edit", () => {
		expect(
			autosaveDelay({
				now: 1_000,
				lastLocalEditAt: 1_000,
				lastAutosaveAt: null,
			}),
		).toBe(AUTOSAVE_IDLE_MS);
	});

	it("saves at once when the editor has been idle long enough", () => {
		expect(
			autosaveDelay({
				now: 10_000,
				lastLocalEditAt: 10_000 - AUTOSAVE_IDLE_MS - 1,
				lastAutosaveAt: null,
			}),
		).toBe(0);
	});

	it("keeps the minimum gap between autosaved versions", () => {
		expect(
			autosaveDelay({
				now: 20_000,
				lastLocalEditAt: 10_000,
				lastAutosaveAt: 15_000,
			}),
		).toBe(15_000 + AUTOSAVE_MIN_INTERVAL_MS - 20_000);
	});
});
