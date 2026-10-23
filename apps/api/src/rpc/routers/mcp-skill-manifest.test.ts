import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import {
	skillMcpProxyIncludesSource,
	resolveSkillMcpNamespaceSlugs,
} from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { BaseContext } from "../orpc";
import { mcpGovernanceContractRouter } from "./mcp-governance";

vi.mock("@tedix/db/queries/skill-runs", () => ({ getSkillRun: vi.fn() }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive/skill-mcp-bindings", () => ({
	skillMcpProxyIncludesSource: vi.fn(),
	resolveSkillMcpNamespaceSlugs: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: vi.fn(),
}));

const input = {
	organizationId: "org-example",
	runId: "run-1",
	skillId: "skill-1",
	tediId: "tedi-1",
	executionEpoch: 2,
	method: "run_tedi_turn",
	targetTediId: "tedi-1",
};
const manifest = parseCapabilityManifest(`---
capabilities:
  mcp:
    tedi: [run_tedi_turn]
    firecrawl: [firecrawl_agent]
---
`);
const run = {
	skillId: "skill-1",
	tediId: "tedi-1",
	executionEpoch: 2,
	status: "running",
	skillRevision: 40,
	capabilityManifest: manifest,
};
const skill = { id: "skill-1", revision: 40, lifecycleState: "active" };
function client(authType = "service-binding") {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType,
			db: {},
			env: { ENVIRONMENT: "development" },
			headers: new Headers(
				authType === "service-binding" ? { "X-Service-Binding": "true" } : {},
			),
			url: new URL("https://api/rpc/mcpGovernance"),
		} as BaseContext,
	});
}

beforeEach(() => {
	vi.mocked(skillMcpProxyIncludesSource).mockResolvedValue(false);
	vi.mocked(getSkillRun).mockResolvedValue(run as never);
	vi.mocked(getSkillEntry).mockResolvedValue(skill as never);
	vi.mocked(resolveSkillMcpNamespaceSlugs).mockResolvedValue({
		namespaceToSlug: { firecrawl: "crawler-example" },
		backfill: {},
		repair: {},
	});
});
describe("workflow manifest authorization", () => {
	it.each(["active", "proven", "crystallized"])(
		"approves declared owning-tedi calls for %s skills",
		async (lifecycleState) => {
			vi.mocked(getSkillEntry).mockResolvedValue({
				...skill,
				lifecycleState,
			} as never);
			await expect(
				client().resolveSkillManifestAuthorization(input),
			).resolves.toEqual({ approved: true, skillId: "skill-1", revision: 40 });
			expect(getSkillRun).toHaveBeenCalledWith(
				expect.anything(),
				"run-1",
				"org-example",
				"development",
			);
		},
	);
	it("allows only a current-revision human certification run of a draft", async () => {
		vi.mocked(getSkillEntry).mockResolvedValue({
			...skill,
			lifecycleState: "draft",
		} as never);
		for (const patch of [
			{ certification: true, createdBy: "user:owner" },
			{ certification: false, createdBy: "schedule" },
			{ certification: true, createdBy: "agent:executor" },
			{ certification: true, createdBy: "user:owner", skillRevision: 39 },
		]) {
			vi.mocked(getSkillRun).mockResolvedValue({ ...run, ...patch } as never);
			const allowed =
				patch.certification &&
				patch.createdBy === "user:owner" &&
				!patch.skillRevision;
			await expect(
				client().resolveSkillManifestAuthorization(input),
			).resolves.toMatchObject({ approved: allowed });
			await expect(
				client().resolveSkillManifestAuthorization({
					...input,
					method: "messages_send",
				}),
			).resolves.toEqual({ approved: false });
		}
	});
	it("resolves renamed app bindings and matches the dispatched provider", async () => {
		const call = {
			...input,
			targetTediId: undefined,
			method: "firecrawl_agent",
			sourceAppSlug: "crawler-example",
		};
		await expect(
			client().resolveSkillManifestAuthorization(call),
		).resolves.toMatchObject({ approved: true });
		await expect(
			client().resolveSkillManifestAuthorization({
				...call,
				sourceAppSlug: "other-app",
			}),
		).resolves.toEqual({ approved: false });
	});
	it("authorizes a declared provider inherited from a bound proxy, never an undeclared method", async () => {
		vi.mocked(skillMcpProxyIncludesSource).mockResolvedValue(true);
		const call = {
			...input,
			targetTediId: undefined,
			method: "firecrawl_agent",
			sourceAppSlug: "crawler-base",
		};
		await expect(
			client().resolveSkillManifestAuthorization(call),
		).resolves.toMatchObject({ approved: true });
		expect(skillMcpProxyIncludesSource).toHaveBeenCalledWith(
			expect.anything(),
			{
				organizationId: "org-example",
				appSlug: "crawler-example",
				sourceAppSlug: "crawler-base",
			},
		);
		vi.mocked(skillMcpProxyIncludesSource).mockClear();
		await expect(
			client().resolveSkillManifestAuthorization({
				...call,
				method: "delete_everything",
			}),
		).resolves.toEqual({ approved: false });
		expect(skillMcpProxyIncludesSource).not.toHaveBeenCalled();
	});
	it.each([
		{ skillId: "forged" },
		{ tediId: "other-tedi" },
		{ executionEpoch: 1 },
		{ status: "completed" },
		{ status: "failed" },
		{ status: "paused" },
		{ workflowRetiredAt: "2026-10-21" },
		{ skillRevision: null },
		{ capabilityManifest: {} },
	])("refuses mismatched, terminal or malformed run: %j", async (patch) => {
		vi.mocked(getSkillRun).mockResolvedValue({ ...run, ...patch } as never);
		await expect(
			client().resolveSkillManifestAuthorization(input),
		).resolves.toEqual({ approved: false });
	});
	it.each(["draft", "stale", "archived"])(
		"refuses %s skills",
		async (lifecycleState) => {
			vi.mocked(getSkillEntry).mockResolvedValue({
				...skill,
				lifecycleState,
			} as never);
			await expect(
				client().resolveSkillManifestAuthorization(input),
			).resolves.toEqual({ approved: false });
		},
	);
	it("refuses missing identities, undeclared tools and other tedis, preserving the pinned revision", async () => {
		await expect(
			client().resolveSkillManifestAuthorization({
				...input,
				method: "messages_send",
			}),
		).resolves.toEqual({ approved: false });
		await expect(
			client().resolveSkillManifestAuthorization({
				...input,
				targetTediId: "other",
			}),
		).resolves.toEqual({ approved: false });
		vi.mocked(getSkillEntry).mockResolvedValue({
			...skill,
			revision: 41,
		} as never);
		await expect(
			client().resolveSkillManifestAuthorization(input),
		).resolves.toEqual({ approved: true, skillId: "skill-1", revision: 40 });
		vi.mocked(getSkillRun).mockResolvedValue(undefined);
		await expect(
			client().resolveSkillManifestAuthorization(input),
		).resolves.toEqual({ approved: false });
	});
	it("rejects a non-service caller", async () => {
		await expect(
			client("user").resolveSkillManifestAuthorization(input),
		).rejects.toThrow();
	});

	describe("scheduled coordinator manifest", () => {
		// Shape of a scheduled coordinator skill: Work reads on the org gateway,
		// its own tedi turn, and turns on two named tedis of the same org.
		const coordinatorManifest = parseCapabilityManifest(`---
capabilities:
  mcp:
    tedix: [list_projects, list_work_items, add_comment]
    tedi: [run_tedi_turn]
    lead: [run_tedi_turn]
    sales: [run_tedi_turn]
---
`);
		const workRead = {
			...input,
			targetTediId: undefined,
			method: "list_projects",
			namespace: "tedix",
			sourceAppSlug: "tedix",
		};
		const leadTurn = {
			...input,
			method: "run_tedi_turn",
			namespace: "lead",
			targetTediId: "tedi-lead",
		};
		beforeEach(() => {
			vi.mocked(getSkillRun).mockResolvedValue({
				...run,
				capabilityManifest: coordinatorManifest,
			} as never);
			vi.mocked(resolveSkillMcpNamespaceSlugs).mockResolvedValue({
				namespaceToSlug: { tedix: "tedix" },
				backfill: {},
				repair: {},
			});
			vi.mocked(getTediByIdForOrganization).mockResolvedValue({
				id: "tedi-lead",
				retiredAt: null,
			} as never);
		});
		it("approves declared Work reads while the skill is active", async () => {
			for (const method of ["list_projects", "list_work_items"])
				await expect(
					client().resolveSkillManifestAuthorization({ ...workRead, method }),
				).resolves.toEqual({
					approved: true,
					skillId: "skill-1",
					revision: 40,
				});
		});
		it("refuses the same declared reads once an edit returns the skill to draft", async () => {
			vi.mocked(getSkillEntry).mockResolvedValue({
				...skill,
				lifecycleState: "draft",
			} as never);
			await expect(
				client().resolveSkillManifestAuthorization(workRead),
			).resolves.toEqual({ approved: false });
		});
		it("approves a declared turn on a named tedi of the same organization", async () => {
			await expect(
				client().resolveSkillManifestAuthorization(leadTurn),
			).resolves.toMatchObject({ approved: true, revision: 40 });
			expect(getTediByIdForOrganization).toHaveBeenCalledWith(
				expect.anything(),
				"tedi-lead",
				"org-example",
			);
		});
		it.each([
			["an undeclared tedi namespace", { namespace: "finance" }],
			["the reserved tedi namespace for another tedi", { namespace: "tedi" }],
			["a namespace bound to an app", { namespace: "tedix" }],
			["an undeclared method", { method: "messages_send" }],
		])("refuses %s", async (_label, patch) => {
			await expect(
				client().resolveSkillManifestAuthorization({ ...leadTurn, ...patch }),
			).resolves.toEqual({ approved: false });
		});
		it.each([
			["outside the organization", undefined],
			["retired", { id: "tedi-lead", retiredAt: "2026-10-01" }],
		])("refuses a named tedi %s", async (_label, tedi) => {
			vi.mocked(getTediByIdForOrganization).mockResolvedValue(tedi as never);
			await expect(
				client().resolveSkillManifestAuthorization(leadTurn),
			).resolves.toEqual({ approved: false });
		});
	});
});
