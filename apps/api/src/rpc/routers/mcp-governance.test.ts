import { DatabaseSync } from "node:sqlite";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { createDbClient } from "@tedix/db/client";
import { apps } from "@tedix/db/schema/apps";
import {
	skillEntries,
	skillRuns,
	skillWorkflowSources,
} from "@tedix/db/schema/cognitive";
import {
	createPinnedSkillRun,
	getSkillRun,
} from "@tedix/db/queries/skill-runs";
import { resolveSkillMcpNamespaceSlugs } from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { mcpGovernanceContractRouter } from "./mcp-governance";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const TEDI_ID = "00000000-0000-4000-8000-000000000002";

function createContext(input?: {
	organizationAutonomy?: boolean;
	tedi?: { id: string; organizationId: string; policyPackId: string | null };
	policyPack?: {
		id: string;
		organizationId: string | null;
		status: "active" | "draft" | "archived";
		definition: Record<string, unknown> | null;
	};
}): BaseContext {
	return {
		authType: "service-binding",
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: async () =>
								input?.organizationAutonomy
									? [
											{
												id: "org-pack",
												version: 1,
												definition: {
													governancePolicy: {
														autonomy: { version: 1, maxRisk: "medium" },
													},
												},
											},
										]
									: [],
						}),
					}),
				}),
			}),
			selectDistinct: () => ({
				from: () => ({ where: () => ({ limit: async () => [] }) }),
			}),
			query: {
				tedis: {
					findFirst: vi.fn(async () => input?.tedi),
				},
				policyPacks: {
					findFirst: vi.fn(async () => input?.policyPack),
				},
			},
		} as unknown as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({ "X-Service-Binding": "true" }),
		organizationId: ORG_ID,
		rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
		url: new URL("https://api/rpc/mcpGovernance"),
	} as BaseContext;
}

describe("MCP governance router — agent transport policy", () => {
	it("resolves organization autonomy for a task-capable caller without inventing a tedi", async () => {
		const context = createContext({ organizationAutonomy: true });
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		await expect(
			client.resolveAgentTransportPolicy({ organizationId: ORG_ID }),
		).resolves.toMatchObject({
			autonomy: {
				version: 1,
				maxRisk: "medium",
				policyPack: { id: "org-pack", version: 1 },
			},
		});
		expect(context.db.query.tedis.findFirst).not.toHaveBeenCalled();
		await expect(
			client.resolveAgentTransportPolicy({
				organizationId: ORG_ID,
				tediId: TEDI_ID,
			}),
		).resolves.toEqual({ requireExplicitApprovalPolicy: false });
	});
	it("resolves an enabled rollout switch from the tedi's active policy pack", async () => {
		const client = createRouterClient(mcpGovernanceContractRouter, {
			context: createContext({
				tedi: {
					id: TEDI_ID,
					organizationId: ORG_ID,
					policyPackId: "pack-1",
				},
				policyPack: {
					id: "pack-1",
					organizationId: ORG_ID,
					status: "active",
					definition: {
						governancePolicy: {
							requireExplicitThirdPartyApprovalPolicy: true,
						},
					},
				},
			}),
		});

		await expect(
			client.resolveAgentTransportPolicy({
				organizationId: ORG_ID,
				tediId: TEDI_ID,
			}),
		).resolves.toEqual({ requireExplicitApprovalPolicy: true });
	});

	it.each([
		["missing tedi", undefined, undefined],
		[
			"missing policy pack",
			{ id: TEDI_ID, organizationId: ORG_ID, policyPackId: "pack-1" },
			undefined,
		],
		[
			"inactive policy pack",
			{ id: TEDI_ID, organizationId: ORG_ID, policyPackId: "pack-1" },
			{
				id: "pack-1",
				organizationId: ORG_ID,
				status: "draft" as const,
				definition: {
					governancePolicy: {
						requireExplicitThirdPartyApprovalPolicy: true,
					},
				},
			},
		],
		[
			"absent rollout switch",
			{ id: TEDI_ID, organizationId: ORG_ID, policyPackId: "pack-1" },
			{
				id: "pack-1",
				organizationId: ORG_ID,
				status: "active" as const,
				definition: { governancePolicy: {} },
			},
		],
	] as const)(
		"preserves the current behavior for %s",
		async (_name, tedi, policyPack) => {
			const client = createRouterClient(mcpGovernanceContractRouter, {
				context: createContext({ tedi, policyPack }),
			});

			await expect(
				client.resolveAgentTransportPolicy({
					organizationId: ORG_ID,
					tediId: TEDI_ID,
				}),
			).resolves.toEqual({ requireExplicitApprovalPolicy: false });
		},
	);
});

describe("scheduled manifest authorization through gateway identities", () => {
	async function fixture() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(apps, skillEntries, skillRuns, skillWorkflowSources));
		const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
		await db.insert(apps).values([
			{
				id: "platform",
				organizationId: "platform-org",
				name: "Platform",
				slug: "tedix",
				visibility: "public",
			},
			{
				id: "os-impostor",
				organizationId: ORG_ID,
				name: "Impostor",
				slug: "os",
				visibility: "private",
			},
			{
				id: "crawler",
				organizationId: ORG_ID,
				name: "Crawler",
				slug: "crawler-fixture",
				visibility: "private",
			},
		]);
		await db.insert(skillEntries).values({
			id: "scheduled-skill",
			organizationId: ORG_ID,
			title: "Daily watcher",
			content: "# Watcher",
			lifecycleState: "active",
			revision: 14,
			mcpAppBindings: { firecrawl_fixture: "crawler", os: "os-impostor" },
		});
		const manifest = parseCapabilityManifest(`---
capabilities:
  mcp:
    os: [get_os_output, revise_os_output, list_os_outputs]
    tedix: [scrape_elements]
    tedi: [run_tedi_turn]
    firecrawl_fixture: [firecrawl_agent]
  network: true
  schedule:
    cron: "30 6 * * *"
---
`);
		await createPinnedSkillRun(db, {
			runId: "scheduled-run",
			skillId: "scheduled-skill",
			tediId: TEDI_ID,
			orgId: ORG_ID,
			workflowInstanceId: "scheduled-run",
			params: {},
			workflowSource: "export default {}",
			skillDoc: "pinned",
			skillRevision: 14,
			capabilityManifest: manifest,
			createdBy: "schedule",
			runtimeEnvironment: "production",
		});
		sqlite.exec(
			"UPDATE skill_runs SET status = 'running', error = NULL WHERE id = 'scheduled-run'",
		);
		const context = { ...createContext(), db } as BaseContext;
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		const call = {
			organizationId: ORG_ID,
			runId: "scheduled-run",
			skillId: "scheduled-skill",
			tediId: TEDI_ID,
			executionEpoch: 0,
		};
		return { sqlite, db, client, call, manifest };
	}

	it("fails closed when the OS platform app cannot be resolved", async () => {
		const { sqlite, client, call } = await fixture();
		try {
			sqlite.exec("DELETE FROM apps WHERE id = 'platform'");
			await expect(
				client.resolveSkillManifestAuthorization({
					...call,
					method: "get_os_output",
					namespace: "os",
					sourceAppSlug: "impostor",
				}),
			).resolves.toEqual({ approved: false });
		} finally {
			sqlite.close();
		}
	});

	it("persists the scheduled snapshot and resolves OS to the platform source app", async () => {
		const { sqlite, db, manifest } = await fixture();
		try {
			expect(manifest.schedule).toMatchObject({
				cron: "30 6 * * *",
				enabled: true,
			});
			await expect(
				getSkillRun(db, "scheduled-run", ORG_ID, "production"),
			).resolves.toMatchObject({
				createdBy: "schedule",
				capabilityManifest: manifest,
				skillRevision: 14,
			});
			await expect(
				resolveSkillMcpNamespaceSlugs(db, {
					organizationId: ORG_ID,
					skillId: "scheduled-skill",
					namespaces: Object.keys(manifest.mcp),
				}),
			).resolves.toMatchObject({
				namespaceToSlug: {
					os: "tedix",
					tedix: "tedix",
					firecrawl_fixture: "crawler-fixture",
				},
			});
		} finally {
			sqlite.close();
		}
	});

	it.each([
		{ method: "get_os_output", namespace: "tedix", sourceAppSlug: "tedix" },
		{ method: "revise_os_output", namespace: "tedix", sourceAppSlug: "tedix" },
		{ method: "list_os_outputs", namespace: "os", sourceAppSlug: "tedix" },
		{ method: "scrape_elements", namespace: "browser", sourceAppSlug: "tedix" },
		{
			method: "run_tedi_turn",
			namespace: "tedi_fixture",
			sourceAppSlug: "fixture-unified",
			targetTediId: TEDI_ID,
		},
		{
			method: "firecrawl_agent",
			namespace: "firecrawl_fixture",
			sourceAppSlug: "crawler-fixture",
		},
	])(
		"approves declared scheduled call $method through $namespace",
		async (target) => {
			const { sqlite, client, call } = await fixture();
			try {
				await expect(
					client.resolveSkillManifestAuthorization({ ...call, ...target }),
				).resolves.toEqual({
					approved: true,
					skillId: "scheduled-skill",
					revision: 14,
				});
			} finally {
				sqlite.close();
			}
		},
	);

	it.each([
		{ method: "get_os_output", namespace: "os", sourceAppSlug: "impostor" },
		{
			method: "get_os_output",
			namespace: "tedix",
			sourceAppSlug: "tedix",
			executionEpoch: 1,
		},
		{
			method: "get_os_output",
			namespace: "tedix",
			sourceAppSlug: "tedix",
			tediId: "forged",
		},
		{
			method: "get_os_output",
			namespace: "tedix",
			sourceAppSlug: "tedix",
			organizationId: "other-org",
		},
		{ method: "delete_os_output", namespace: "tedix", sourceAppSlug: "tedix" },
		{
			method: "run_tedi_turn",
			namespace: "tedi_fixture",
			targetTediId: "other-tedi",
		},
		{
			method: "firecrawl_agent",
			namespace: "firecrawl_fixture",
			sourceAppSlug: "impostor",
		},
	])("refuses undeclared or mismatched scheduled call %j", async (target) => {
		const { sqlite, client, call } = await fixture();
		try {
			await expect(
				client.resolveSkillManifestAuthorization({ ...call, ...target }),
			).resolves.toEqual({ approved: false });
		} finally {
			sqlite.close();
		}
	});
});
