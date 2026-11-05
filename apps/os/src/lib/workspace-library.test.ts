import { describe, expect, it } from "vite-plus/test";

import { workspaceDescriptionForDisplay } from "./workspace-library";

describe("workspaceDescriptionForDisplay", () => {
	it("drops a parenthetical that carries a raw user id", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Private notes for Sam (tedix user Q7xk2Lm9Np4Rt8Vw3Yz6Bc1Df5)",
			),
		).toBe("Private notes for Sam");
	});

	it("removes a bare UUID and tidies punctuation", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Owned by 8f2ca634-dbd4-410e-80a0-16eaeac0cfe9. Weekly review.",
			),
		).toBe("Owned by. Weekly review.");
	});

	it("keeps an id that is part of a link", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Design: https://tedix.os.tedix.dev/outputs/641d8739-2e09-4b4a-b694-cd4601a8269b",
			),
		).toBe(
			"Design: https://tedix.os.tedix.dev/outputs/641d8739-2e09-4b4a-b694-cd4601a8269b",
		);
	});

	it("keeps readable text and readable parentheticals", () => {
		expect(
			workspaceDescriptionForDisplay("Revenue reporting (weekly, 2026)"),
		).toBe("Revenue reporting (weekly, 2026)");
	});

	it("returns null when only an id or nothing is left", () => {
		expect(workspaceDescriptionForDisplay("Q7xk2Lm9Np4Rt8Vw3Yz6Bc1Df5")).toBe(
			null,
		);
		expect(workspaceDescriptionForDisplay("")).toBe(null);
		expect(workspaceDescriptionForDisplay(null)).toBe(null);
	});
});
