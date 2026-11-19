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
	it.each(["list_skills", "workers_builds_list_builds"])(
		"accepts tool id %s",
		(toolId) => {
			expect(ToolIdSchema.safeParse(toolId).success).toBe(true);
		},
	);

	it.each(["skills_list", "listSkills", "list__skills"])(
		"rejects tool id %s",
		(toolId) => {
			expect(ToolIdSchema.safeParse(toolId).success).toBe(false);
		},
	);
});

describe("CreateAppToolInputSchema stateful toolId boundary", () => {
	it("passes a bounded noun-first id to the state-aware API write validator", () => {
		expect(
			CreateAppToolInputSchema.safeParse({
				...VALID_CREATE_INPUT,
				toolId: "skills_list",
			}).success,
		).toBe(true);
	});
});

describe("UpdateAppToolInputSchema rename surface", () => {
	it("has no toolId field — the logical id is immutable, so a rename to a non-conforming id is impossible", () => {
		expect("toolId" in UpdateAppToolInputSchema.shape).toBe(false);
	});
});
