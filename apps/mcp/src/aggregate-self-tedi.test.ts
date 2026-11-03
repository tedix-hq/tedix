import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withSelfTediSkills } from "./aggregate-self-tedi";
import { filterAggregateTedisForCodeNamespaces } from "./codemode-targeting";
import { buildAggregateTediTools } from "./mcp/aggregate-tedis";

const { get, getApiClient } = vi.hoisted(() => {
	const get = vi.fn();
	return { get, getApiClient: vi.fn(() => ({ tedis: { get } })) };
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
