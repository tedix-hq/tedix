import { describe, expect, it } from "vite-plus/test";
import { ToolIdSchema } from "../schemas/tools";
import {
	CreateAppToolInputSchema,
	UpdateAppToolInputSchema,
} from "./app-tools";

const VALID_CREATE_INPUT = {
	toolTypeId: "rpc",
	toolId: "list_skills",
	title: "List skills",
};

describe("ToolIdSchema (verb-first snake_case, CLAUDE.md 'MCP Tool Naming')", () => {
	it.each([
		["list_skills"],
		["run_skill_workflow"],
		["get_skill"],
		["record_skill"],
		["cancel_skill_workflow"],
		["register_muscle_memory"],
		["capture_page"],
	])("accepts verb-first id %s", (toolId) => {
		expect(ToolIdSchema.safeParse(toolId).success).toBe(true);
	});

	it.each([["gmail_send"], ["workers_builds_list_builds"]])(
		"accepts allowlisted multi-product namespace prefix id %s",
		(toolId) => {
			expect(ToolIdSchema.safeParse(toolId).success).toBe(true);
		},
	);

	it.each([
		["skills_list"], // noun-first
		["widgets_list"], // noun-first, prefix not an allowlisted namespace
		["notion_pages"], // no verb at all
		["listSkills"], // camelCase
		["skills.list"], // namespace-dotted
		["skills-list"], // kebab-case
		["_list_skills"], // leading underscore
		["list__skills"], // double underscore
		["list_skills_"], // trailing underscore
	])("rejects new non-conforming id %s with the rule and the doc", (toolId) => {
		const result = ToolIdSchema.safeParse(toolId);
		expect(result.success).toBe(false);
		if (!result.success) {
			const message = result.error.issues[0]?.message ?? "";
			expect(message).toContain(toolId);
			expect(message).toContain('CLAUDE.md "MCP Tool Naming"');
		}
	});
});

describe("CreateAppToolInputSchema stateful toolId boundary", () => {
	it("accepts a verb-first id", () => {
		expect(CreateAppToolInputSchema.safeParse(VALID_CREATE_INPUT).success).toBe(
			true,
		);
	});

	it("passes a bounded noun-first id to the state-aware API write validator", () => {
		expect(
			CreateAppToolInputSchema.safeParse({
				...VALID_CREATE_INPUT,
				toolId: "skills_list",
			}).success,
		).toBe(true);
	});

	it("accepts re-submitting a grandfathered id because create is an upsert", () => {
		expect(
			CreateAppToolInputSchema.safeParse({
				...VALID_CREATE_INPUT,
				toolId: "memory_search",
			}).success,
		).toBe(true);
	});
});

describe("UpdateAppToolInputSchema rename surface", () => {
	it("has no toolId field — the logical id is immutable, so a rename to a non-conforming id is impossible", () => {
		expect("toolId" in UpdateAppToolInputSchema.shape).toBe(false);
	});

	it("update of an existing (grandfathered or not) row parses without naming the id", () => {
		expect(
			UpdateAppToolInputSchema.safeParse({ title: "Renamed title only" })
				.success,
		).toBe(true);
	});
});
