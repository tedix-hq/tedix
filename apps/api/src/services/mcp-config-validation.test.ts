import { describe, expect, it } from "vite-plus/test";
import {
	validateAdapterScopeString,
	validateToolIdStyle,
	validateToolIdWriteState,
} from "./mcp-config-validation";

describe("validateToolIdStyle", () => {
	it.each([
		["list_skills"],
		["run_skill_workflow"],
		["get_skill"],
		["gmail_send"],
		["workers_builds_list_builds"],
		["capture_page"],
	])("accepts verb-first snake_case id %s without issues", (toolId) => {
		expect(validateToolIdStyle(toolId)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
	});

	it.each([
		["memory_search"],
		["content_publish"],
		["work_item_claim"],
		["email_send"],
	])("rejects a pre-convention id %s in strict mode", (toolId) => {
		const result = validateToolIdStyle(toolId);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.warnings).toEqual([]);
	});

	it.each([
		["skills_list"], // noun-first
		["listSkills"], // camelCase
		["Skills_List"], // capitalized
		["skills.list"], // namespace-dotted
		["skills-list"], // kebab-case
		["_list_skills"], // leading underscore
		["list__skills"], // double underscore
		["list_skills_"], // trailing underscore
	])(
		"rejects new non-conforming id %s with an error naming the doc",
		(toolId) => {
			const result = validateToolIdStyle(toolId);
			expect(result.valid).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.errors).toEqual([
				expect.objectContaining({
					path: "toolId",
					message: expect.stringContaining(toolId),
				}),
			]);
			expect(result.errors[0]?.message).toContain(
				'CLAUDE.md "MCP Tool Naming"',
			);
		},
	);

	it("downgrades a violation to a warning on advisory paths (enforce: false)", () => {
		const result = validateToolIdStyle("skills_list", { enforce: false });
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({
				path: "toolId",
				message: expect.stringContaining("skills_list"),
			}),
		]);
	});
});

describe("validateToolIdWriteState", () => {
	it("rejects a new non-conforming create id", () => {
		expect(
			validateToolIdWriteState("skills_list", {
				operation: "create",
				exists: false,
			}),
		).toMatchObject({ valid: false, warnings: [] });
	});

	it("warns when create re-submits an existing generated id", () => {
		expect(
			validateToolIdWriteState("acceptContentSlot", {
				operation: "create",
				exists: true,
			}),
		).toMatchObject({
			valid: true,
			errors: [],
			warnings: [{ path: "toolId" }],
		});
	});

	it("warns for update because the logical id is immutable", () => {
		expect(
			validateToolIdWriteState("skills_list", {
				operation: "update",
				exists: true,
			}),
		).toMatchObject({
			valid: true,
			errors: [],
			warnings: [{ path: "toolId" }],
		});
	});
});

describe("validateAdapterScopeString", () => {
	it.each([
		undefined,
		null,
		"primary",
		"all",
		'["adapter-a", "adapter-a", " adapter-b "]',
	])("accepts supported scope %s", (scope) => {
		expect(validateAdapterScopeString(scope)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
	});
	it.each([
		[
			"invalid",
			"adapterScope must be 'primary', 'all', or a JSON string array of adapter IDs.",
		],
		[
			"{}",
			"adapterScope JSON must be an array of adapter IDs when not using 'primary' or 'all'.",
		],
		["[]", "adapterScope array must contain at least one adapter ID."],
		['[" "]', "adapterScope array values must all be non-empty strings."],
		["[null]", "adapterScope array values must all be non-empty strings."],
	])("preserves application validation issue for %s", (scope, message) => {
		expect(validateAdapterScopeString(scope)).toEqual({
			valid: false,
			errors: [{ path: "adapterScope", message }],
			warnings: [],
		});
	});
});
