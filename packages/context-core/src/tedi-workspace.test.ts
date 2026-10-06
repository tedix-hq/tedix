import { describe, expect, it } from "vite-plus/test";
import { resolveWorkspaceFiles } from "./tedi-workspace";

describe("resolveWorkspaceFiles", () => {
	it("renders caller-supplied templates without persistence access", () => {
		const result = resolveWorkspaceFiles(
			{
				name: "Tedi",
				slug: "tedi",
				displayName: "Tedi Prime",
				language: "en",
				timezone: "UTC",
			},
			{ files: { soul: "# {{name}} — {{slug}}" } },
		);

		expect(result.workspaceFiles["SOUL.md"]).toBe("# Tedi Prime — tedi");
		expect(result.platformFiles["HEARTBEAT.md"]).toContain(
			"No cron templates configured",
		);
	});

	it("uses authenticated runtime authority without legacy verification challenges", () => {
		const result = resolveWorkspaceFiles({
			name: "Tedi",
			slug: "tedi",
			displayName: "Tedi Prime",
			language: "en",
			timezone: "UTC",
		});
		const instructions = result.workspaceFiles["AGENTS.md"] ?? "";
		expect(instructions).toContain("No Shared-Secret Challenges");
		expect(instructions).toContain("Never ask for a daily verification code");
		expect(instructions).not.toContain("TEDIX_VERIFIED_OWNER");
		expect(instructions).not.toContain("fall back to your normal verification");
	});
	it.each([
		["harden", "Hardened"],
		["repair-only", "Repair Only"],
	] as const)(
		"renders %s strategy with custom templates and compiled directives",
		(strategy, heading) => {
			const result = resolveWorkspaceFiles(
				{ name: "Tedi", slug: "tedi", displayName: "Tedi Prime" },
				{ files: { agents: "# {{name}} instructions" } },
				null,
				["Preserve customer data", "Preserve customer data"],
				null,
				strategy,
			);
			const instructions = result.workspaceFiles["AGENTS.md"] ?? "";
			expect(instructions).toContain("# Tedi Prime instructions");
			expect(instructions).toContain(`## Evolution Strategy: ${heading}`);
			expect(instructions).not.toContain("## Evolution Strategy: Balanced");
			expect(instructions.match(/- Preserve customer data/g)).toHaveLength(1);
		},
	);
});
