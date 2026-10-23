import { describe, expect, it } from "vite-plus/test";
import { sessionProjectBinding } from "./session-project-binding";

describe("session project prefixes", () => {
	it("matches case-insensitively at a topic boundary, choosing the longest prefix", () => {
		const bindings = [
			{ prefix: "AI", projectId: "general" },
			{ prefix: "AI GUILD", projectId: "community" },
		];
		for (const name of [
			"ai guild",
			" AI GUILD — event",
			"AI GUILD: planning",
			"AI GUILD/topic",
		])
			expect(sessionProjectBinding(name, bindings)).toBe("community");
		expect(sessionProjectBinding("AIMLESS", bindings)).toBeUndefined();
		expect(sessionProjectBinding("Unmapped", bindings)).toBeUndefined();
		expect(bindings[0]?.prefix).toBe("AI");
	});
});
