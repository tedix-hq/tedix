/**
 * Golden cases for the pure projection helpers. Every expected value below was
 * captured from the unsplit `tool-schema-sync.ts` before the projection band
 * moved into its own module, so a passing run proves the split changed no
 * output. The contract hashes are the strongest check: they cover the
 * generated JSON Schemas, tool id, title, description, config, annotations,
 * meta and widget columns of one endpoint at once. The endpoints are
 * synthetic so a real contract change cannot move these hashes; a projector
 * change must bump them deliberately.
 */
import type { ResolvedContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import type { AppTool } from "@tedix/db/schema";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";
import {
	annotationsForEndpoint,
	generatedToolIdForEndpoint,
	mergeGeneratedConfig,
	projectionContractHash,
	titleFromToolId,
} from "./tool-schema-projection";

function endpoint(
	overrides: Partial<ResolvedContractEndpoint> & {
		router: string;
		procPath: string;
	},
): ResolvedContractEndpoint {
	const proc = overrides.procPath.split("/").at(-1)!;
	return {
		proc,
		route: undefined,
		inputSchema: z.object({ id: z.string() }),
		outputSchema: undefined,
		...overrides,
	};
}

const emptyObjectSchema = {
	type: "object",
	properties: {},
} as unknown as AppTool["inputSchema"];

const listSkillsByApp = endpoint({
	router: "skills",
	procPath: "listByApp",
	route: {
		method: "GET",
		path: "/skills/by-app",
		summary: "List skills by app",
		description: "List the skills attached to one app.",
	},
	inputSchema: z.object({
		appId: z.string().uuid(),
		limit: z.number().int().min(1).max(100).optional(),
	}),
	outputSchema: z.object({
		items: z.array(z.object({ id: z.string(), name: z.string() })),
	}),
});

const runDurableCode = endpoint({
	router: "tedis",
	procPath: "runTediDurableCode",
	route: { method: "POST", path: "/tedis/{tediId}/code" },
	inputSchema: z.object({ tediId: z.string(), code: z.string() }),
});

const listMembers = endpoint({
	router: "members",
	procPath: "list",
	route: { method: "GET", path: "/organizations/{organizationId}/members" },
	inputSchema: z.object({ organizationId: z.string().uuid() }),
});

describe("generatedToolIdForEndpoint", () => {
	it.each([
		[endpoint({ router: "apps", procPath: "get" }), "get_apps"],
		[
			endpoint({ router: "skills", procPath: "listByApp" }),
			"list_skills_by_app",
		],
		[
			endpoint({ router: "skills", procPath: "listForMcp" }),
			"list_skills_for_mcp",
		],
		[
			endpoint({ router: "memoryGraph", procPath: "searchMemoryGraph" }),
			"search_memory_graph",
		],
		[
			endpoint({ router: "apiKeys", procPath: "rotateAccessKey" }),
			"rotate_access_key",
		],
		[endpoint({ router: "graph", procPath: "gaps/detect" }), "gaps_detect"],
		[
			endpoint({
				router: "docs",
				procPath: "listSites",
				route: { operationId: "listDocsSites" },
			}),
			"list_docs_sites",
		],
	])("%o → %s", (candidate, expected) => {
		expect(generatedToolIdForEndpoint(candidate)).toBe(expected);
	});
});

describe("titleFromToolId", () => {
	it.each([
		["list_gadget_tools", "List App Tools"],
		["get_gadgets", "Get Apps"],
		["run_skill_workflow", "Run Skill Workflow"],
		["__odd__", "Odd"],
	])("%s → %s", (toolId, expected) => {
		expect(titleFromToolId(toolId)).toBe(expected);
	});
});

describe("annotationsForEndpoint", () => {
	it("infers hints from the method and verb when no kind is declared", () => {
		expect(annotationsForEndpoint(listSkillsByApp)).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			annotationsForEndpoint(
				endpoint({
					router: "apps",
					procPath: "deleteApp",
					route: { method: "DELETE" },
				}),
			),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			annotationsForEndpoint(
				endpoint({
					router: "apps",
					procPath: "replaceApp",
					route: { method: "PUT" },
				}),
			),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			annotationsForEndpoint(
				endpoint({ router: "seo", procPath: "researchKeywords" }),
			),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
	});

	it("maps a declared kind and keeps the open-world allowlist", () => {
		expect(annotationsForEndpoint(listSkillsByApp, "write")).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(
			annotationsForEndpoint(
				endpoint({ router: "seo", procPath: "researchKeywords" }),
				"read",
			),
		).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("pins stored session source reads regardless of kind", () => {
		for (const procPath of ["listActivity", "listEvents"])
			expect(
				annotationsForEndpoint(
					endpoint({ router: "workAgentSessions", procPath }),
					"write",
				),
			).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
				untrustedContentHint: true,
			});
	});
});

describe("mergeGeneratedConfig", () => {
	it("derives a fresh rpc config from the endpoint and input schema", () => {
		expect(
			mergeGeneratedConfig(undefined, listSkillsByApp, {
				type: "object",
				properties: { appId: {}, tediId: {} },
			} as unknown as AppTool["inputSchema"]),
		).toEqual({
			transport: "rpc",
			endpoint: "skills/listByApp",
			responsePath: "json",
			method: "GET",
			allowExplicitTediId: true,
			allowExplicitAppId: true,
		});
	});

	it("keeps stored opt-ins and widget columns, drops everything else", () => {
		const existing = {
			toolId: "list_skills_by_app",
			config: {
				transport: "rpc",
				endpoint: "skills/listByApp",
				nativeDirect: true,
				layoutId: "skills-table",
				layoutSpec: { type: "table" },
				responseMap: { rows: "items" },
				staticOutput: { note: "kept" },
				modelSummaryTemplate: "{rows}",
				unrelated: "dropped",
				timeout: 5,
			},
		} as unknown as AppTool;
		expect(
			mergeGeneratedConfig(existing, listSkillsByApp, emptyObjectSchema),
		).toEqual({
			transport: "rpc",
			endpoint: "skills/listByApp",
			responsePath: "json",
			method: "GET",
			nativeDirect: true,
			layoutId: "skills-table",
			layoutSpec: { type: "table" },
			responseMap: { rows: "items" },
			staticOutput: { note: "kept" },
			modelSummaryTemplate: "{rows}",
		});
	});

	it("applies a widget override", () => {
		expect(
			mergeGeneratedConfig(undefined, listSkillsByApp, emptyObjectSchema, {
				layoutId: "skills-cards",
				layoutSpec: { type: "cards" },
			}),
		).toEqual({
			transport: "rpc",
			endpoint: "skills/listByApp",
			responsePath: "json",
			method: "GET",
			layoutId: "skills-cards",
			layoutSpec: { type: "cards" },
		});
	});

	it("opts the CLI's reviewed Work endpoints into native transport", () => {
		// `tedix work move` and `work accept --executor` call this natively; a
		// row without the opt-in is ineligible and the CLI refuses the call.
		const updateSpecification = endpoint({
			router: "workItems",
			procPath: "updateSpecification",
			route: { method: "POST", path: "/work-items/{id}/specification" },
		});
		expect(
			mergeGeneratedConfig(undefined, updateSpecification, emptyObjectSchema),
		).toEqual({
			transport: "rpc",
			endpoint: "workItems/updateSpecification",
			responsePath: "json",
			method: "POST",
			nativeDirect: true,
		});
		expect(
			mergeGeneratedConfig(undefined, listSkillsByApp, emptyObjectSchema),
		).not.toHaveProperty("nativeDirect");
	});

	it("floors the durable code transport timeout and keeps a longer one", () => {
		expect(
			mergeGeneratedConfig(undefined, runDurableCode, {
				type: "object",
				properties: { tediId: {} },
			} as unknown as AppTool["inputSchema"]),
		).toEqual({
			transport: "rpc",
			endpoint: "tedis/runTediDurableCode",
			responsePath: "json",
			method: "POST",
			timeout: 315_000,
			allowExplicitTediId: true,
		});
		expect(
			mergeGeneratedConfig(
				{ config: { timeout: 9_999_999 } } as unknown as AppTool,
				runDurableCode,
				emptyObjectSchema,
			),
		).toEqual({
			transport: "rpc",
			endpoint: "tedis/runTediDurableCode",
			responsePath: "json",
			method: "POST",
			timeout: 9_999_999,
		});
	});

	it("injects the caller org only for allowlisted org sub-collections", () => {
		expect(
			mergeGeneratedConfig(undefined, listMembers, emptyObjectSchema),
		).toEqual({
			transport: "rpc",
			endpoint: "members/list",
			responsePath: "json",
			method: "GET",
			injectOrganizationId: true,
		});
	});
});

describe("projectionContractHash", () => {
	it("matches the hashes the pre-split projector produced", async () => {
		await expect(projectionContractHash(listSkillsByApp, {})).resolves.toBe(
			"bd843e3fe458c6a222696c85189b6a999262e5b6934dc2c42f694f6ed9ced1ea",
		);
		await expect(
			projectionContractHash(listSkillsByApp, {
				resolvedToolId: "list_skills_for_app",
				kindOverrides: { "skills/listByApp": "read" },
			}),
		).resolves.toBe(
			"9c823191402c3cec0d883e0d807d4e3f41f94e16de54e8309174e8e753f1b508",
		);
		await expect(
			projectionContractHash(listSkillsByApp, {
				widgetOverrides: {
					"skills/listByApp": {
						layoutId: "skills-cards",
						description: "Skill cards",
						layoutSpec: { type: "cards" },
					},
				},
			}),
		).resolves.toBe(
			"869521c32dcd467165f2b469597344df9ee17d9f21924f48c3d9b5213bd8ea88",
		);
		await expect(
			projectionContractHash(runDurableCode, {
				toolIdOverrides: {
					"tedis/runTediDurableCode": "run_tedi_durable_code",
				},
			}),
		).resolves.toBe(
			"b5d5d82fe8a490fbb2fe891caa66d5f2f9abbf43f4d384ef0f45900df8c3ca1b",
		);
		await expect(projectionContractHash(listMembers, {})).resolves.toBe(
			"807148237a360a093558f8beeb23634289a9730cf9bbbfa11bd66d7b049c3aa2",
		);
	});
});
