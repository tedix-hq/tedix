import { describe, expect, it } from "vite-plus/test";
import {
	detectPrematureHeaderClose,
	validateSkillInput,
	validateWorkflowSource,
} from "./skill-validation";

const base = {
	title: "Probe Skill",
	description: "A probe skill used by validation tests",
	summary: "probe",
	toolSlugs: ["list_skills"],
};

const skillDoc = (schedule: string) => `---
name: probe
description: probe
capabilities:
  schedule:
    cron: "${schedule}"
---
Body.`;

describe("validate_skill schedule parity with the scheduler", () => {
	it("rejects a cron the scheduler cannot parse and names the syntax", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("MON * * * *"),
		});
		expect(result.valid).toBe(false);
		const issue = result.errors.find(
			(e) => e.code === "SKILL_SCHEDULE_INVALID",
		);
		expect(issue?.message).toContain("Supported cron syntax");
	});

	it("accepts a range with a step and warns the row only exists when active", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: skillDoc("0-59/5 * * * *"),
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings.map((w) => w.code)).toContain(
			"SKILL_SCHEDULE_PROJECTED_WHEN_ACTIVE",
		);
	});

	it("warns when frontmatter is invalid YAML instead of silently dropping it", async () => {
		const result = await validateSkillInput({} as never, {
			...base,
			content: "---\nname: x\ndescription: a: b\n---\nBody.",
		});
		expect(result.warnings.map((w) => w.code)).toContain(
			"SKILL_FRONTMATTER_INVALID_YAML",
		);
	});
});

describe("workflow header comment", () => {
	const body = `export default { async run() { return 1; } };`;
	const caps = { mcp: {}, network: false } as never;

	it("flags a cron step that closes the /* tedix */ header early", () => {
		const source = `/* tedix
name: probe
capabilities:
  schedule:
    cron: "*/5 * * * *"
*/
${body}`;
		expect(detectPrematureHeaderClose(source)).toContain("closes early");
		const errors = validateWorkflowSource(source, "scripts/workflow.ts", caps);
		expect(errors.map((e) => e.code)).toContain(
			"WORKFLOW_HEADER_COMMENT_CLOSED_EARLY",
		);
	});

	it("accepts a well-formed header and a source without one", () => {
		const header = `/* tedix
name: probe
cron: "0-59/5 * * * *"
*/
${body}`;
		expect(detectPrematureHeaderClose(header)).toBeNull();
		expect(detectPrematureHeaderClose(body)).toBeNull();
		expect(detectPrematureHeaderClose(`/* note */ ${body}`)).toBeNull();
	});
});
