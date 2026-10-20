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
