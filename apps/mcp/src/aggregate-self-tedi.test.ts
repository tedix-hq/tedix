import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";
import { resolveDefaultCallableTedis } from "./aggregate-default-tedis";
import { withSelfTediSkills } from "./aggregate-self-tedi";
import { directlyCalledCodeModeNamespaces } from "./mcp/code-mode-namespaces";
import { filterAggregateTedisForCodeNamespaces } from "./codemode-targeting";
import { buildAggregateTediTools } from "./mcp/aggregate-tedis";

const { get, listCallableBySlugs, getApiClient } = vi.hoisted(() => {
	const get = vi.fn();
	const listCallableBySlugs = vi.fn();
	return {
		get,
		listCallableBySlugs,
		getApiClient: vi.fn(() => ({ tedis: { get, listCallableBySlugs } })),
	};
});
vi.mock("./lib/api-client", () => ({ getApiClient }));

const tedi = {
	id: "tedi-research",
	slug: "research",
	organizationId: "org-example",
	status: "active",
	runtimeState: "active",
};
const input = () => ({
	entries: [{ slug: "peer" }],
	caller: {
		authType: "tedi" as const,
		tediId: tedi.id,
		organizationId: tedi.organizationId,
	},
	organizationId: tedi.organizationId,
	env: {
		API_SERVICE: {},
		MCP_URL: "https://mcp.example.test",
	} as CloudflareEnv,
});

beforeEach(() => {
	vi.clearAllMocks();
	get.mockResolvedValue(tedi);
});

describe("self skill namespace", () => {
	it("mounts a missing self namespace for discovery and a targeted workflow call", async () => {
		const args = input();
		const entries = await withSelfTediSkills(args);
		expect(args.entries).toEqual([{ slug: "peer" }]);
		expect(get).toHaveBeenCalledWith({ tediId: tedi.id });
		expect(getApiClient).toHaveBeenCalledWith({
			serviceFetch: args.env.API_SERVICE,
			orgId: tedi.organizationId,
		});
		const tools = buildAggregateTediTools(
			filterAggregateTedisForCodeNamespaces(entries, new Set(["research"]))!,
			args.env,
		);
		const run = tools.find(
			(tool) => tool.toolId === "research__run_skill_workflow",
		);
		expect(run?.config).toMatchObject({
			endpoint: "skills/runWorkflow",
			staticParams: { tediId: tedi.id },
			_aggregateNamespace: "research",
			_aggregateTediId: tedi.id,
			_aggregateTediOrgId: tedi.organizationId,
			allowExplicitTediId: false,
		});
		expect(run?.annotations?.destructiveHint).toBe(true);
		expect(
			tools.some(
				(tool) => tool.toolId === "research__get_skill_workflow_status",
			),
		).toBe(true);
		expect(tools.some((tool) => tool.toolId === "research__exec")).toBe(false);
	});

	it.each(["oauth", "service", "anonymous"] as const)(
		"does not derive self authority from %s callers",
		async (authType) => {
			const args = input();
			const entries = await withSelfTediSkills({
				...args,
				caller: { ...args.caller, authType },
			});
			expect(entries).toBe(args.entries);
			expect(get).not.toHaveBeenCalled();
		},
	);

	it("does not add tools to a non-aggregate app or another organization", async () => {
		for (const args of [
			{ ...input(), entries: undefined },
			{ ...input(), organizationId: "org-other" },
		])
			expect(await withSelfTediSkills(args)).toBe(args.entries);
		expect(get).not.toHaveBeenCalled();
	});

	it("exposes self skills even when no peers are configured", async () => {
		const entries = await withSelfTediSkills({ ...input(), entries: [] });
		expect(entries).toEqual([
			expect.objectContaining({ slug: "research", selfSkillsOnly: true }),
		]);
	});

	it.each([
		{ organizationId: "org-other" },
		{ id: "tedi-other" },
		{ status: "paused" },
		{ runtimeState: "archived" },
		{ slug: null },
	])(
		"rejects unavailable or mismatched canonical identity: %j",
		async (change) => {
			get.mockResolvedValue({ ...tedi, ...change });
			const args = input();
			expect(await withSelfTediSkills(args)).toBe(args.entries);
		},
	);

	it.each([
		{
			slug: "research",
			namespace: "configured",
			surface: "collaboration" as const,
		},
		{ slug: "peer", namespace: "research" },
	])("preserves configured namespaces and collisions: %j", async (entry) => {
		const args = { ...input(), entries: [entry] };
		expect(await withSelfTediSkills(args)).toBe(args.entries);
	});

	it("fails closed when canonical identity cannot be read", async () => {
		get.mockRejectedValue(new Error("identity unavailable"));
		await expect(withSelfTediSkills(input())).rejects.toThrow(
			"identity unavailable",
		);
	});
});

describe("tedis callable by default", () => {
	const personal = {
		slug: "mira-lindqvist",
		id: "tedi-mira",
		organizationId: "org-example",
		scope: "personal" as const,
		runtimeKind: "agent" as const,
	};
	const owner = {
		authType: "oauth" as const,
		userId: "user-mira",
		organizationId: "org-example",
	};
	const resolve = (
		change: Partial<Parameters<typeof resolveDefaultCallableTedis>[0]> = {},
	) =>
		resolveDefaultCallableTedis({
			entries: [{ slug: "cto" }],
			caller: owner,
			organizationId: "org-example",
			env: {
				API_SERVICE: {},
				MCP_URL: "https://mcp.example.test",
			} as CloudflareEnv,
			calledNamespaces: directlyCalledCodeModeNamespaces(
				'async () => mira_lindqvist.run_tedi_turn({ text: "hi" })',
			),
			tools: [],
			mcpConfig: { aggregateApps: [{ slug: "cms" }] },
			...change,
		});

	beforeEach(() => {
		// The API applies the ownership rule; it answers by the caller it is told.
		listCallableBySlugs.mockImplementation(
			async (input: { callerUserId?: string }) => ({
				data: input.callerUserId === owner.userId ? [personal] : [],
			}),
		);
	});

	it("mounts the owner's personal tedi with run_tedi_turn and messages_read only", async () => {
		const entries = await resolve();
		expect(listCallableBySlugs).toHaveBeenCalledTimes(1);
		expect(listCallableBySlugs).toHaveBeenCalledWith({
			organizationId: "org-example",
			slugs: ["mira-lindqvist", "mira_lindqvist"],
			callerUserId: owner.userId,
		});
		expect(entries).toEqual([
			{
				slug: "mira-lindqvist",
				surface: "turns",
				tediId: "tedi-mira",
				organizationId: "org-example",
				runtimeKind: "agent",
			},
		]);
		const env = { MCP_URL: "https://mcp.example.test" } as CloudflareEnv;
		const tools = buildAggregateTediTools(entries, env);
		expect(tools.map((tool) => tool.toolId).sort()).toEqual([
			"mira_lindqvist__messages_read",
			"mira_lindqvist__run_tedi_turn",
		]);
		// The same tools an explicit full entry builds, so routing, the run task
		// link and client_request_id handling are the full bridge's.
		const full = buildAggregateTediTools(
			[{ ...entries[0]!, surface: "full" }],
			env,
		);
		expect(full.length).toBeGreaterThan(tools.length);
		for (const tool of tools)
			expect(full.find((other) => other.toolId === tool.toolId)).toEqual(tool);
		const byName = (name: string) =>
			tools.find((tool) => tool.toolId === `mira_lindqvist__${name}`)!;
		expect(byName("run_tedi_turn").config).toMatchObject({
			transport: "mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "tedi-mira",
			_aggregateTediOrgId: "org-example",
		});
		// A namespace no gateway config lists still resolves its messaging scopes.
		for (const mcpConfig of [undefined, { toolScopes: { cto: ["x"] } }])
			expect(
				["run_tedi_turn", "messages_read"].map((name) =>
					resolveMcpToolRequiredScopes(
						byName(name),
						"mira_lindqvist",
						mcpConfig,
						{ fallbackOnAuthenticatedAuthMode: true },
					),
				),
			).toEqual([["mcp:messaging.write"], ["mcp:messaging.read"]]);
	});

	it("does not tell the API another member is the owner", async () => {
		expect(
			await resolve({ caller: { ...owner, userId: "user-other" } }),
		).toEqual([]);
		expect(listCallableBySlugs).toHaveBeenCalledWith(
			expect.objectContaining({ callerUserId: "user-other" }),
		);
	});

	it.each([
		{ authType: "tedi" as const, tediId: "tedi-peer" },
		{ authType: "oauth" as const, tediId: "tedi-bound" },
		{ authType: "service" as const },
		{ authType: "service" as const, kernel: true },
		{ authType: "m2m" as const },
		{ authType: "apiKey" as const },
		{ authType: "external_agent" as const },
	])(
		"never names a person, and drops a personal tedi, for %j",
		async (change) => {
			// Even an API that wrongly returned the personal tedi must not mount it.
			listCallableBySlugs.mockResolvedValue({ data: [personal] });
			expect(await resolve({ caller: { ...owner, ...change } })).toEqual([]);
			expect(listCallableBySlugs).toHaveBeenCalledTimes(1);
			expect(listCallableBySlugs.mock.calls[0]![0]).not.toHaveProperty(
				"callerUserId",
			);
		},
	);

	it.each([
		{ caller: undefined },
		{ caller: { ...owner, authType: "anonymous" as const } },
		{ caller: { ...owner, organizationId: "org-other" } },
		{ organizationId: undefined },
	])("reads nothing for a caller outside the organization", async (change) => {
		expect(await resolve(change)).toEqual([]);
		expect(listCallableBySlugs).not.toHaveBeenCalled();
	});

	it.each([
		// A configured app, a built-in, an explicit tedi and local variables.
		"async () => { const rows = await cms.list(); return rows.items.map((r) => r.id); }",
		'async () => cto.run_tedi_turn({ text: "hi" })',
		'async () => { const hits = await discover.search({ query: "x" }); return flow.status({ runId: hits[0].id }); }',
		"async () => skills.list_skills({})",
	])("makes no API call when every namespace is known: %s", async (code) => {
		expect(
			await resolve({
				calledNamespaces: directlyCalledCodeModeNamespaces(code),
			}),
		).toEqual([]);
		expect(listCallableBySlugs).not.toHaveBeenCalled();
	});

	it("makes no API call for a namespace a loaded tool already serves", async () => {
		expect(
			await resolve({
				tools: [
					{
						toolId: "mira_lindqvist__search",
						config: { _aggregateNamespace: "mira_lindqvist" },
					},
				] as unknown as Parameters<
					typeof resolveDefaultCallableTedis
				>[0]["tools"],
			}),
		).toEqual([]);
		expect(listCallableBySlugs).not.toHaveBeenCalled();
	});

	it.each([
		[{ slug: "mira-lindqvist", surface: "full" as const }],
		[{ slug: "other", namespace: "mira_lindqvist" }],
	])("leaves an explicit entry untouched: %j", async (entry) => {
		expect(await resolve({ entries: [entry] })).toEqual([]);
		expect(listCallableBySlugs).not.toHaveBeenCalled();
	});

	it("keeps the tools of explicit full and collaboration entries", () => {
		const env = { MCP_URL: "https://mcp.example.test" } as CloudflareEnv;
		const names = (surface?: "full" | "collaboration") =>
			buildAggregateTediTools([{ slug: "cto", surface }], env).map(
				(tool) => tool.toolId,
			);
		expect(names()).toEqual(names("full"));
		expect(names("full")).toEqual(
			expect.arrayContaining(["cto__run_tedi_turn", "cto__exec"]),
		);
		expect(names("collaboration")).toContain("cto__ask");
		expect(names("collaboration")).not.toContain("cto__run_tedi_turn");
		expect(names("collaboration")).not.toContain("cto__exec");
	});

	it("drops rows of another organization and names the program did not call", async () => {
		listCallableBySlugs.mockResolvedValue({
			data: [
				{ ...personal, organizationId: "org-other" },
				{ ...personal, slug: "uncalled", id: "tedi-uncalled" },
			],
		});
		expect(await resolve()).toEqual([]);
	});

	it("mounts nothing when the API call fails", async () => {
		listCallableBySlugs.mockRejectedValue(new Error("unavailable"));
		expect(await resolve()).toEqual([]);
	});
});
