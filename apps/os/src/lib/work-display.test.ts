import { describe, expect, it } from "vite-plus/test";
import { workPrincipalTooltip } from "./work-display";

describe("workPrincipalTooltip", () => {
	const id = "0a1b2c3d-0000-4000-8000-000000000000";

	it("shows the name when the directory knows it", () => {
		const names = new Map([[`tedi:${id}`, "CTO"]]);
		expect(workPrincipalTooltip("tedi", id, names)).toBe("CTO");
	});

	it("falls back to the kind, never the type:uuid pair", () => {
		expect(workPrincipalTooltip("tedi", id)).toBe("Tedi");
		expect(workPrincipalTooltip("external_agent", id)).toBe("Agent");
		expect(workPrincipalTooltip("user", id, new Map())).not.toContain(id);
	});
});
