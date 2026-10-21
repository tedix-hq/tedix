import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { resolveSkillMcpNamespaceSlugs } from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import type { BaseContext } from "../orpc";
import { mcpGovernanceContractRouter } from "./mcp-governance";

vi.mock("@tedix/db/queries/skill-runs", () => ({ getSkillRun: vi.fn() }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive/skill-mcp-bindings", () => ({
	resolveSkillMcpNamespaceSlugs: vi.fn(),
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
});
