import { DatabaseSync } from "node:sqlite";
import { fictionalPolicyProvider } from "../../../../mcp/src/mcp/fictional-policy-provider.test-helper";
import { callUpstreamMcpTool } from "../../../../mcp/src/mcp/upstream-mcp-client";
import { buildNamespaceGroups } from "../../../../mcp/src/mcp/codemode-execution";
import { ToolHandler } from "../../../../mcp/src/mcp/handler";
import { IdenticalFailureBudget } from "../../../../../packages/tedi-codemode-core/src/failure-budget";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { canonicalDigest } from "../../lib/blueprint-digest";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { resolveHumanPolicyReplay } from "../../../../mcp/src/mcp/tenant-human-replay";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
	resolveFreshPolicyMount,
	prepareTenantIdentityProfileMount,
} from "../../../../mcp/src/mcp/tenant-policy-mount";
import { appsContractRouter } from "./apps";
import { enforceMcpAccess } from "../../../../mcp/src/mcp-access";
import { isTenantPolicyEdgeAdmission } from "../../../../mcp/src/mcp/tenant-edge-policy";
import { resolveTenantProfileCandidate } from "../../../../mcp/src/mcp/tenant-profile-candidate";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { apps } from "@tedix/db/schema/apps";
import { appTools, appToolCspDomains } from "@tedix/db/schema";
import {
	providerProbeReceipts,
	providerProbeResults,
} from "@tedix/db/schema/provider-probe-receipts";
import {
	tenantProviderIdentityProfiles,
	tenantProviderIdentityPreparations,
	tenantToolPolicyResourceGenerations,
	tenantToolPolicyPreparations,
	tenantToolPolicies,
	tenantToolPolicyMountRevisions,
} from "@tedix/db/schema/tenant-tool-policy";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { probeReviewedProviderIdentity } from "../../../../mcp/src/mcp/tenant-profile-probe";
import { userContext } from "../test-context";
import { mcpGovernanceContractRouter } from "./mcp-governance";

describe("owner policy against a real local D1 facade", () => {
	it("enforces an owner-reviewed rule through edge, Code Mode, provider and replay", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(
				schemaDdl(
					organizations,
					organizationMembers,
					apps,
					appTools,
					appToolCspDomains,
					tediApprovalRequests,
					tenantProviderIdentityProfiles,
					tenantProviderIdentityPreparations,
					tenantToolPolicyResourceGenerations,
					tenantToolPolicyPreparations,
					tenantToolPolicies,
					tenantToolPolicyMountRevisions,
					providerProbeReceipts,
					providerProbeResults,
				),
			);
			const db = createDbClient(createD1Facade(sqlite));
			await db
				.insert(organizations)
				.values({ id: "fictional-org", name: "Sample", slug: "sample" });
			await db.insert(organizationMembers).values({
				id: "member",
				organizationId: "fictional-org",
				descopeUserId: "owner",
				email: "owner@example.invalid",
				role: "owner",
				status: "active",
			});
			await db.insert(apps).values({
				id: "00000000-0000-4000-8000-000000000001",
				organizationId: "fictional-org",
				name: "Sample",
				slug: "sample",
			});
			const auth = {
				type: "connection" as const,
				connectionId: "fictional-provider",
				credentialScope: "user" as const,
			};
			for (const operation of ["write", "identity"]) {
				await db.insert(appTools).values({
					id: operation,
					appId: "00000000-0000-4000-8000-000000000001",
					toolTypeId: "mcp",
					toolId: operation,
					title: operation,
					enabled: true,
					authRequired: true,
					writeCapability: operation === "write" ? "destructive" : "read",
					config: {
						transport: "mcp",
						mcpServerUrl: "https://fictional.example.invalid/mcp",
						mcpToolName: operation,
						auth,
					},
				});
			}
			const handler = new RPCHandler({
				apps: appsContractRouter,
				mcpGovernance: mcpGovernanceContractRouter,
			});
			const gatewayEnv = {
				ENVIRONMENT: "test",
				PLATFORM_SERVICE_TOKEN: "fictional-test-secret",
				API_SERVICE: {
					fetch: async (request: Request) => {
						if (
							new URL(request.url).pathname.endsWith(
								"/connections/fetchOrgToken",
							)
						) {
							if (
								request.headers.get("X-Tedix-Org-Id") !== "fictional-org" ||
								request.headers.get("X-Tedix-Acting-User") !== "owner"
							)
								return new Response("Denied", { status: 403 });
							return Response.json({
								json: {
									accessToken: "fictional-token",
									selectedCredential: {
										organizationId: "fictional-org",
										providerId: "fictional-provider",
										scope: "user",
										userId: "owner",
									},
								},
							});
						}
						const { response } = await handler.handle(request, {
							prefix: "/rpc",
							context: {
								authType: "service-binding",
								organizationId: "fictional-org",
								db,
								env: { ENVIRONMENT: "test" },
								headers: request.headers,
								url: new URL(request.url),
								gatewayEndUserId:
									request.headers.get("X-Tedix-End-User-Id") ?? undefined,
								tediScopes: (request.headers.get("X-Tedix-Tedi-Scopes") ?? "")
									.split(" ")
									.filter(Boolean),
							} as never,
						});
						return response ?? new Response("missing", { status: 404 });
					},
				},
			} as unknown as CloudflareEnv;
			const gateway = createRouterClient(mcpGovernanceContractRouter, {
				context: {
					authType: "service-binding",
					organizationId: "fictional-org",
					db,
					env: { ENVIRONMENT: "test" },
					headers: new Headers({ "X-Service-Binding": "true" }),
					url: new URL("https://api.test/rpc"),
					rateLimiter: { limit: async () => ({ success: true }) },
				} as never,
			});
			const provider = { account: "account-a", writes: 0 };
			const fetcher = fictionalPolicyProvider(provider);
			vi.stubGlobal("fetch", fetcher);
			const upstream = {
				url: "https://fictional.example.invalid/mcp",
				fetcher,
				headers: { Authorization: "Bearer fictional-token" },
				modernOnly: false,
				signal: new AbortController().signal,
				timeoutMs: 5000,
			};
			const secret = "fictional-test-secret";
			const service = {
				fetch: async (request: Request) => {
					if (request.url.endsWith("/probe-profile")) {
						const body = (await request.json()) as {
							organizationId: string;
							receiptId: string;
							exampleArgs: Record<string, unknown>;
						};
						let credentialSummary:
							| { scope: "user" | "tenant"; connectionInstanceId?: string }
							| undefined;
						const accountRevisionDigest = await probeReviewedProviderIdentity({
							...body,
							env: gatewayEnv,
							onCredentialSummary: (summary) => {
								credentialSummary = summary;
							},
						});
						return Response.json({ accountRevisionDigest, credentialSummary });
					}
					const body = (await request.json()) as {
						organizationId: string;
						rootAppId: string;
						mountedToolId: string;
					};
					const result = await prepareTenantIdentityProfileMount({
						...body,
						env: gatewayEnv,
					});
					return result
						? Response.json(result)
						: new Response("mount unavailable", { status: 404 });
				},
			};
			const owner = createRouterClient(mcpGovernanceContractRouter, {
				context: userContext({
					organizationId: "fictional-org",
					userId: "owner",
					sub: "owner",
					claims: { scopes: ["connections.execute"] },
					permissions: ["settings:manage"],
					db,
					env: {
						ENVIRONMENT: "test",
						MCP_SERVICE: service,
					} as unknown as CloudflareEnv,
				}),
			});
			const input = {
				rootAppId: "00000000-0000-4000-8000-000000000001",
				mountedToolId: "sample__write",
				probeMountedToolId: "sample__identity",
				selectors: [["account", "id"]],
			};
			const first = await owner.prepareProviderIdentityProfile(input);
			sqlite.exec(
				`UPDATE app_tools SET config = json_set(config, '$.mcpToolName', 'changed') WHERE id = 'write'`,
			);
			await expect(
				owner.createProviderIdentityProfile({
					preparationId: first.preparationId,
					expectedProfileDigest: first.profileDigest,
					safetyAttestation: "safe_empty_probe",
				}),
			).rejects.toThrow();
			sqlite.exec(
				`UPDATE app_tools SET config = json_set(config, '$.mcpToolName', 'write') WHERE id = 'write'`,
			);
			const reviewed = await owner.prepareProviderIdentityProfile(input);
			const saved = await owner.createProviderIdentityProfile({
				preparationId: reviewed.preparationId,
				expectedProfileDigest: reviewed.profileDigest,
				safetyAttestation: "safe_empty_probe",
			});
			expect((await owner.listProviderIdentityProfiles()).items).toMatchObject([
				{ id: saved.profile.id, profileDigest: reviewed.profileDigest },
			]);
			const exampleArgs = { action: "edit" };
			const proof = await owner.probeProviderIdentityProfile({
				profileId: saved.profile.id,
				exampleArgs,
			});
			expect(proof.credentialSummary).toEqual({ scope: "user" });
			const prepared = await owner.prepareHybridTenantToolPolicy({
				profileId: saved.profile.id,
				resultReceiptId: proof.resultReceiptId,
				exampleArgs,
			});
			await expect(
				owner.prepareHybridTenantToolPolicy({
					profileId: saved.profile.id,
					resultReceiptId: proof.resultReceiptId,
					exampleArgs,
				}),
			).rejects.toThrow();
			const policySet = {
				evaluatorVersion: 1 as const,
				defaultDisposition: "ask" as const,
				rules: [
					{
						id: "edit",
						predicate: {
							version: 1 as const,
							schema: {
								type: "object" as const,
								properties: {
									action: { type: "string" as const, const: "edit" },
								},
								required: ["action"],
								additionalProperties: false,
							},
						},
						effect: {
							disposition: "allow" as const,
							riskTier: "bounded_write" as const,
							blastRadius: "single_resource" as const,
						},
					},
					{
						id: "review",
						predicate: {
							version: 1 as const,
							schema: {
								type: "object" as const,
								properties: {
									action: { type: "string" as const, const: "review" },
								},
								required: ["action"],
								additionalProperties: false,
							},
						},
						effect: {
							disposition: "ask" as const,
							riskTier: "bounded_write" as const,
							blastRadius: "single_resource" as const,
						},
					},
				],
			};
			const policy = await owner.createTenantToolPolicy({
				preparationId: prepared.preparationId,
				expectedDescriptorDigest: prepared.descriptorDigest,
				exampleArgs,
				policySet,
			});
			await expect(
				gateway.resolveTenantToolPolicy({
					organizationId: "other-org",
					descriptor: prepared.descriptor,
					descriptorDigest: prepared.descriptorDigest,
					args: exampleArgs,
				}),
			).rejects.toThrow();
			const candidate = {
				organizationId: "fictional-org",
				rootAppId: "00000000-0000-4000-8000-000000000001",
				mountedToolId: "sample__write",
				actorUserId: "owner",
				args: exampleArgs,
			};
			expect(
				(await gateway.resolveTenantPolicyCandidate(candidate)).candidate
					?.effect?.disposition,
			).toBe("allow");
			const altered = {
				...prepared.descriptor,
				accountRevisionDigest: "f".repeat(64),
			};
			expect(
				(
					await gateway.resolveTenantToolPolicy({
						organizationId: "fictional-org",
						descriptor: altered,
						descriptorDigest: prepared.descriptorDigest,
						args: exampleArgs,
					})
				).matched,
			).toBe(false);
			expect(
				(
					await gateway.resolveTenantToolPolicy({
						organizationId: "fictional-org",
						descriptor: altered,
						descriptorDigest: await canonicalDigest(altered),
						args: exampleArgs,
					})
				).matched,
			).toBe(false);
			await db.insert(tenantToolPolicyMountRevisions).values({
				organizationId: "fictional-org",
				rootAppId: candidate.rootAppId,
				mountedToolId: candidate.mountedToolId,
				policyId: "unknown-fixture",
				subjectKey: null,
			});
			expect(
				(
					await gateway.resolveTenantPolicyDiscovery({
						organizationId: candidate.organizationId,
						rootAppId: candidate.rootAppId,
						mountedToolId: candidate.mountedToolId,
						actorUserId: candidate.actorUserId,
					})
				).potential,
			).toBe(false);
			expect(
				(await gateway.resolveTenantPolicyCandidate(candidate)).candidate,
			).toBeNull();
			sqlite
				.prepare(
					"DELETE FROM tenant_tool_policy_mount_revisions WHERE policy_id = ?",
				)
				.run("unknown-fixture");
			expect(
				(
					await gateway.resolveTenantPolicyCandidate({
						...candidate,
						actorUserId: "other",
					})
				).candidate,
			).toBeNull();
			expect(
				(
					await gateway.resolveTenantPolicyCandidate({
						...candidate,
						args: { action: "delete" },
					})
				).candidate?.defaultAsk,
			).toBe(true);
			const mounted = await resolveFreshPolicyMount({
				organizationId: "fictional-org",
				rootAppId: candidate.rootAppId,
				mountedToolId: candidate.mountedToolId,
				env: gatewayEnv,
			});
			expect(mounted).not.toBeNull();
			const selection = {
				organizations: [
					{
						organizationId: "fictional-org",
						gatewaySlug: "sample",
						descopeTenantId: "fictional-tenant",
					},
				],
			};
			const app = {
				app: {
					id: "00000000-0000-4000-8000-000000000002",
					slug: "connect",
					organizationId: "fictional-platform",
				},
				metadata: { mcpConfig: { multiOrgConsent: true } },
				tools: [mounted!.tool],
			};
			const request = (args: Record<string, unknown>) =>
				new Request("https://fictional.example.invalid/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-tedix-auth-type": "oauth",
						"x-tedix-auth-user-id": "owner",
						"x-tedix-auth-scopes": "connections.execute",
					},
					body: JSON.stringify({
						method: "tools/call",
						params: { name: candidate.mountedToolId, arguments: args },
					}),
				});
			expect(
				await isTenantPolicyEdgeAdmission({
					request: request(exampleArgs),
					app: app as never,
					env: gatewayEnv,
					multiOrgSelection: selection,
				}),
			).toBe(true);
			const edge = {
				hostname: "connect.mcp.tedix.dev",
				resolvedApp: app as never,
				env: gatewayEnv,
				multiOrgSelection: selection,
				oauthJwtPayload: null,
				isDev: false,
			};
			expect(
				await enforceMcpAccess({ ...edge, request: request(exampleArgs) }),
			).toBeNull();
			expect(
				(
					await enforceMcpAccess({
						...edge,
						request: request({ action: "delete" }),
					})
				)?.reason,
			).toBe("insufficient_scope");
			expect(
				await isTenantPolicyEdgeAdmission({
					request: request({ action: "delete" }),
					app: app as never,
					env: gatewayEnv,
					multiOrgSelection: selection,
				}),
			).toBe(false);
			const agent = {
				env: gatewayEnv,
				appId: app.app.id,
				appSlug: "connect",
				app: app.app,
				loadedTools: new Map([[mounted!.tool.toolId, mounted!.tool]]),
				appCapabilities: {},
				toolOutputTemplates: new Map(),
				toolHandler: new ToolHandler(),
				appMetadata: app.metadata,
				callerIdentity: {
					authType: "oauth",
					userId: "owner",
					scopes: ["connections.execute"],
					verifiedMultiOrgOrganizations: selection.organizations,
				},
			};
			const resolved = await resolveTenantProfileCandidate(
				agent as never,
				mounted!.tool,
				exampleArgs,
			);
			expect(resolved?.effect.disposition).toBe("allow");
			const refs = {
				authorizationDenial: undefined,
				approvalResult: undefined,
				approvalExtra: undefined,
				approvalSource: undefined,
				replayUnsafeBuiltinCalls: 0,
				executionId: undefined,
				paymentExtra: undefined,
				paymentResponses: [],
				rpcCallCount: 0,
				rpcNamespaces: new Set(),
				sideEffectQueue: Promise.resolve(),
				failureBudget: new IdenticalFailureBudget(),
				discoverCalls: 0,
				discoverParameterRequests: 0,
				toolReceipts: [],
				skillWorkflowRunIds: new Set(),
				readObservations: [],
				collectionReads: [],
				ownerHostSession: undefined,
			};
			const groups = buildNamespaceGroups(
				agent as never,
				undefined,
				refs,
				new Set(),
			);
			await groups.get("sample")!.fns.write!(exampleArgs);
			expect(provider.writes).toBe(1);
			const call = {
				...upstream,
				toolName: "write",
				args: exampleArgs,
				identityProbe: {
					...resolved!.probe,
					binding: JSON.stringify([
						resolved!.probe.binding,
						{
							organizationId: "fictional-org",
							providerId: "fictional-provider",
							scope: "user",
							userId: "owner",
						},
					]),
					secret,
				},
			};
			expect((await callUpstreamMcpTool(call)).ok).toBe(true);
			expect(provider.writes).toBe(2);
			provider.account = "account-b";
			expect((await callUpstreamMcpTool(call)).ok).toBe(false);
			expect(provider.writes).toBe(2);
			provider.account = "account-a";
			const reviewArgs = { action: "review" };
			const ask = (
				await gateway.resolveTenantPolicyCandidate({
					...candidate,
					args: reviewArgs,
				})
			).candidate!;
			expect(ask.effect?.disposition).toBe("ask");
			const policyBinding = {
				descriptor: ask.descriptor,
				descriptorDigest: ask.descriptorDigest,
				revisionId: ask.revisionId,
				ruleDigest: ask.ruleDigest,
			};
			const target = {
				transport: "mcp",
				endpoint: null,
				mcpToolName: "write",
				providerId: "fictional-provider",
				configHash: await sha256Hex(JSON.stringify(mounted!.tool.config ?? {})),
				tenantPolicyBinding: policyBinding,
			};
			const approvalId = "00000000-0000-4000-8000-000000000003";
			const fingerprint = await canonicalDigest({
				organizationId: "fictional-org",
				userId: "owner",
				appSlug: "sample",
				toolId: mounted!.tool.toolId,
				target,
				args: reviewArgs,
			});
			await db.insert(tediApprovalRequests).values({
				id: approvalId,
				tediId: "fictional-tedi",
				orgId: "fictional-org",
				actionType: "mcp.tool_call",
				description: "Reviewed fictional action",
				status: "approved",
				createdAt: "2026-01-01T00:00:00.000Z",
				expiresAt: "2999-01-01T00:00:00.000Z",
				resolvedBy: "user:owner",
				payload: {
					kind: "mcp_tool_call",
					initiatedByUserId: "owner",
					fingerprint,
					toolId: mounted!.tool.toolId,
					target,
					args: reviewArgs,
				},
			});
			const replayAgent = {
				...agent,
				apiClient: {
					mcpGovernance: {
						requestOwnerToolApproval: gateway.requestOwnerToolApproval,
					},
				},
				appId: candidate.rootAppId,
				appSlug: "sample",
				app: {
					id: candidate.rootAppId,
					slug: "sample",
					organizationId: "fictional-org",
				},
				callerIdentity: {
					authType: "service",
					kernel: true,
					userId: "owner",
					organizationId: "fictional-org",
					scopes: ["connections.execute"],
				},
			};
			await expect(
				resolveHumanPolicyReplay(
					replayAgent as never,
					mounted!.tool,
					{ action: "other" },
					approvalId,
				),
			).rejects.toThrow();
			await expect(
				resolveHumanPolicyReplay(
					{
						...replayAgent,
						callerIdentity: { ...replayAgent.callerIdentity, userId: "other" },
					} as never,
					mounted!.tool,
					reviewArgs,
					approvalId,
				),
			).rejects.toThrow();
			provider.account = "account-b";
			expect(
				await resolveHumanPolicyReplay(
					replayAgent as never,
					mounted!.tool,
					reviewArgs,
					approvalId,
				),
			).toBeNull();
			const readApproval = () =>
				JSON.parse(
					(
						sqlite
							.prepare(
								"SELECT payload FROM tedi_approval_requests WHERE id = ?",
							)
							.get(approvalId) as { payload: string }
					).payload,
				);
			expect(readApproval().consumedAt).toBeUndefined();
			provider.account = "account-a";
			const replay = await resolveHumanPolicyReplay(
				replayAgent as never,
				mounted!.tool,
				reviewArgs,
				approvalId,
			);
			expect(replay?.revisionId).toBe(policy.policy.id);
			expect(readApproval().consumedAt).toBeUndefined();
			const replayRefs = {
				...refs,
				approvalExtra: { _meta: { "com.tedix/approvalRequestId": approvalId } },
				rpcCallCount: 0,
				sideEffectQueue: Promise.resolve(),
				failureBudget: new IdenticalFailureBudget(),
				toolReceipts: [],
			};
			const replayGroups = buildNamespaceGroups(
				replayAgent as never,
				undefined,
				replayRefs,
				new Set(),
			);
			await replayGroups.get("sample")!.fns.write!(reviewArgs);
			expect(provider.writes).toBe(3);
			expect(readApproval().consumedAt).toEqual(expect.any(String));
			await expect(
				replayGroups.get("sample")!.fns.write!(reviewArgs),
			).rejects.toThrow();
			expect(provider.writes).toBe(3);
			const pendingAfterRevocation = "00000000-0000-4000-8000-000000000004";
			sqlite
				.prepare(
					"INSERT INTO tedi_approval_requests SELECT ?, tedi_id, org_id, action_type, description, json_remove(payload, '$.consumedAt'), status, created_at, expires_at, resolved_at, resolved_by, resolution, workflow_id FROM tedi_approval_requests WHERE id = ?",
				)
				.run(pendingAfterRevocation, approvalId);
			await owner.revokeTenantToolPolicy({ id: policy.policy.id });
			await expect(
				resolveHumanPolicyReplay(
					replayAgent as never,
					mounted!.tool,
					reviewArgs,
					pendingAfterRevocation,
				),
			).rejects.toThrow();
			expect(
				JSON.parse(
					(
						sqlite
							.prepare(
								"SELECT payload FROM tedi_approval_requests WHERE id = ?",
							)
							.get(pendingAfterRevocation) as { payload: string }
					).payload,
				).consumedAt,
			).toBeUndefined();
			expect((await callUpstreamMcpTool(call)).ok).toBe(false);
			expect(provider.writes).toBe(3);
			expect(
				(await gateway.resolveTenantPolicyCandidate(candidate)).candidate,
			).toBeNull();
		} finally {
			vi.unstubAllGlobals();
			sqlite.close();
		}
	});
});
