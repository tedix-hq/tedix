import { DatabaseSync } from "node:sqlite";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { createDbClient } from "@tedix/db/client";
import { apps } from "@tedix/db/schema/apps";
import {
	skillEntries,
	skillRuns,
	skillWorkflowSources,
} from "@tedix/db/schema/cognitive";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { connectionInstances } from "@tedix/db/schema/connection-instances";
import { connectionProviders } from "@tedix/db/schema/connection-providers";
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
	organizationAutonomy?: boolean | "opt-out";
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
														autonomy:
															input.organizationAutonomy === "opt-out"
																? false
																: { version: 1, maxRisk: "medium" },
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
			// An unknown tedi gets no platform-default autonomy.
		).resolves.toEqual({
			requireExplicitApprovalPolicy: false,
			platformAutonomy: false,
		});
	});
	it("reports an organization's platform-default opt-out", async () => {
		const client = createRouterClient(mcpGovernanceContractRouter, {
			context: createContext({ organizationAutonomy: "opt-out" }),
		});
		await expect(
			client.resolveAgentTransportPolicy({ organizationId: ORG_ID }),
		).resolves.toEqual({
			requireExplicitApprovalPolicy: false,
			platformAutonomy: false,
		});
		const defaults = createRouterClient(mcpGovernanceContractRouter, {
			context: createContext({}),
		});
		await expect(
			defaults.resolveAgentTransportPolicy({ organizationId: ORG_ID }),
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
			).resolves.toEqual({
				requireExplicitApprovalPolicy: false,
				...(tedi ? {} : { platformAutonomy: false }),
			});
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

describe("sensitive-data latch through the gateway", () => {
	function fixture() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(
			schemaDdl(
				skillRuns,
				kernelRuntimeRuns,
				connectionProviders,
				connectionInstances,
			),
		);
		sqlite
			.prepare(
				"INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment, status) VALUES ('run-1', ?, 'skill-1', ?, 'wf-1', 'production', 'running')",
			)
			.run(ORG_ID, TEDI_ID);
		sqlite
			.prepare(
				"INSERT INTO connection_providers (id, default_data_sensitivity, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES ('crm', 'confidential', 'CRM', 'CRM', 'crm', 'business', 'api_key', 'tenant', '[]', '[]')",
			)
			.run();
		const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
		const context = { ...createContext(), db } as BaseContext;
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		// A continuation or approval replay reaches the API as a new request.
		const later = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...createContext(), db } as BaseContext,
		});
		return { sqlite, client, later };
	}
	const runRef = { kind: "skill_run" as const, id: "run-1" };

	it("latches on a declared sensitive read and keeps the latch for later requests", async () => {
		const { sqlite, client, later } = fixture();
		try {
			await expect(
				client.resolveRunSensitiveDataLatch({ organizationId: ORG_ID, runRef }),
			).resolves.toEqual({ known: true, latch: null });
			const latched = await client.latchRunSensitiveData({
				organizationId: ORG_ID,
				runRef,
				source: {
					appSlug: "hr",
					toolId: "list_salaries",
					connectionProviderId: null,
					toolDeclaredSensitive: true,
				},
			});
			expect(latched.latch).toMatchObject({
				source: { toolId: "list_salaries", reason: "tool_declared_sensitive" },
			});
			await expect(
				later.resolveRunSensitiveDataLatch({ organizationId: ORG_ID, runRef }),
			).resolves.toMatchObject({
				known: true,
				latch: { source: { toolId: "list_salaries" } },
			});
			await expect(
				later.resolveRunSensitiveDataLatch({
					organizationId: "00000000-0000-4000-8000-00000000dead",
					runRef,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		} finally {
			sqlite.close();
		}
	});

	it("tells the gateway whether a connection is restricted, inside its own organization only", async () => {
		const { sqlite, client } = fixture();
		try {
			await expect(
				client.resolveConnectionSensitivity({
					organizationId: ORG_ID,
					connectionProviderId: "crm",
				}),
			).resolves.toEqual({ restricted: false });
			sqlite
				.prepare(
					"INSERT INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, data_sensitivity, token_ids, created_at, updated_at) VALUES ('inst-1', 'user-1', ?, 'crm', 'main', 'restricted', '[]', 'now', 'now')",
				)
				.run(ORG_ID);
			await expect(
				client.resolveConnectionSensitivity({
					organizationId: ORG_ID,
					connectionProviderId: "crm",
				}),
			).resolves.toEqual({ restricted: true });
			await expect(
				client.resolveConnectionSensitivity({
					organizationId: "00000000-0000-4000-8000-00000000dead",
					connectionProviderId: "crm",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		} finally {
			sqlite.close();
		}
	});

	it("leaves an ordinary connected read alone until the connection is restricted", async () => {
		const { sqlite, client } = fixture();
		try {
			const source = {
				appSlug: "crm",
				toolId: "list_contacts",
				connectionProviderId: "crm",
				toolDeclaredSensitive: false,
			};
			await expect(
				client.latchRunSensitiveData({
					organizationId: ORG_ID,
					runRef,
					source,
				}),
			).resolves.toEqual({ known: true, latch: null });
			sqlite
				.prepare(
					"INSERT INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, data_sensitivity, token_ids, created_at, updated_at) VALUES ('inst-1', 'user-1', ?, 'crm', 'main', 'restricted', '[]', 'now', 'now')",
				)
				.run(ORG_ID);
			await expect(
				client.latchRunSensitiveData({
					organizationId: ORG_ID,
					runRef,
					source,
				}),
			).resolves.toMatchObject({
				latch: {
					source: { toolId: "list_contacts", reason: "connection_restricted" },
				},
			});
		} finally {
			sqlite.close();
		}
	});
});
