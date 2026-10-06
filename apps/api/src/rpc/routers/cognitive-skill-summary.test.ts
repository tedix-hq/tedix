import { describe, expect, it } from "vite-plus/test";
import { summarizeSkillEntry } from "./cognitive-skill-catalog";

describe("summarizeSkillEntry", () => {
	it("previews content with a surface-agnostic truncation marker and nulls files", () => {
		// A listing scan needs identity + counters, not every row's full
		// SKILL.md. `content` is required by SkillEntrySchema, so the compact
		// form is a marked preview — a truncated body must never be
		// mistakable for the real one.
		const entry = summarizeSkillEntry({
			content: "x".repeat(2_000),
			files: { "scripts/workflow.ts": "y".repeat(40_000) },
		});
		expect(entry.content.length).toBeLessThan(400);
		expect(entry.content).toContain("[summary view — truncated");
		// The marker must NOT name a tool: `read_skill` is a tedi-runtime native
		// that tenant aggregates do not mount, so the old pointer sent agents
		// after a tool their surface lacks.
		expect(entry.content).not.toContain("read_skill");
		expect(entry.files).toBeNull();
	});

	it("leaves short content unmarked so small skills round-trip verbatim", () => {
		const entry = summarizeSkillEntry({ content: "short body", files: null });
		expect(entry.content).toBe("short body");
		expect(entry.files).toBeNull();
	});
});
