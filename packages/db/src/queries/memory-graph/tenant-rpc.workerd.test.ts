/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { SearchResultSchema } from "@tedix/api-contract/schemas/memory-graph";
import type { TenantStore } from "../../tenant-store/store";
import { tenantStoreStub } from "../../tenant-store/router";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { memoryStoreName } from "../../tenant-store/memory-owner";
import {
	queryMemory,
	queryOwnedMemory,
	type MemoryOperation,
	type MemoryQuery,
} from "./tenant-rpc";

const namespace = (
	env as unknown as { TENANT_STORE: DurableObjectNamespace<TenantStore> }
).TENANT_STORE;
const config = { plane: "do-local-sqlite", namespace, env } as const;
const now = "2026-11-06T12:00:00.000Z";
let counter = 0;
function fixture(label: string) {
	const scope = {
		organizationId: `fictional-memory-${label}-${++counter}`,
		workspaceId: "workspace-a",
	};
	const query = <K extends MemoryOperation>(request: MemoryQuery<K>) =>
		queryMemory(config, scope, request);
	return { scope, query };
}
async function failure(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected RPC rejection");
}

function fact(id: string) {
	return {
		id,
		content: "Cobalt migration uses workspace stores",
		factType: "technical",
		visibility: "org",
		reviewStatus: "confirmed",
		memoryScope: "org",
		usePolicy: "can_use_as_evidence",
		tediId: "tedi-a",
		validFrom: "2026-11-05T10:00:00.000Z",
		createdAt: "2026-11-05T10:00:00.000Z",
	} as const;
}

describe("memory TenantStore RPC in workerd", () => {
	it("routes organization memory without workspace membership and keeps workspace/personal owners separate", async () => {
		const organizationId = `fictional-owners-${++counter}`;
		const access = {
			organizationId,
			principalId: "principal-a",
			workspaceIds: ["workspace-a"],
		};
		const organization = { kind: "organization", organizationId } as const;
		const workspace = {
			kind: "workspace",
			organizationId,
			workspaceId: "workspace-a",
		} as const;
		const personal = {
			kind: "personal",
			organizationId,
			principalId: "principal-a",
		} as const;
		for (const owner of [organization, workspace, personal]) {
			const created = await queryOwnedMemory(config, owner, access, {
				operation: "createFact",
				input: {
					...fact("same-id"),
					content: `${owner.kind} cobalt decision`,
					visibility: "private",
					memoryScope: "tedi",
					usePolicy: "requires_user_confirmation",
					topicKey: "storage/cobalt",
				},
			});
			expect(created).toMatchObject({
				organizationId,
				tediId: "tedi-a",
				visibility: "private",
				memoryScope: "tedi",
				usePolicy: "requires_user_confirmation",
			});
		}
		for (const owner of [organization, workspace, personal]) {
			const found = await queryOwnedMemory(config, owner, access, {
				operation: "getFact",
				input: { factId: "same-id" },
			});
			expect(found?.content).toBe(`${owner.kind} cobalt decision`);
			expect(
				(
					await queryOwnedMemory(config, owner, access, {
						operation: "topicFacts",
						input: { topicKey: "storage/cobalt" },
					})
				).map((row) => row.id),
			).toEqual(["same-id"]);
			expect(
				(
					await queryOwnedMemory(config, owner, access, {
						operation: "temporalRecall",
						input: { query: "what changed yesterday", now, tediId: "tedi-a" },
					})
				).map((row) => row.factId),
			).toEqual(["same-id"]);
			await queryOwnedMemory(config, owner, access, {
				operation: "createFact",
				input: {
					...fact("citation"),
					source: "consolidation://observation",
					usePolicy: "do_not_inject_automatically",
					metadata: {
						consolidation: { evidence: { sources: [{ id: "same-id" }] } },
					},
				},
			});
			expect(
				await queryOwnedMemory(config, owner, access, {
					operation: "citationDependents",
					input: { factIds: ["same-id"] },
				}),
			).toEqual(["citation"]);
		}
		const withoutWorkspace = { ...access, workspaceIds: [] };
		expect(
			(
				await queryOwnedMemory(config, organization, withoutWorkspace, {
					operation: "getFact",
					input: { factId: "same-id" },
				})
			)?.content,
		).toBe("organization cobalt decision");
		const candidates = await queryOwnedMemory(
			config,
			organization,
			withoutWorkspace,
			{
				operation: "lexicalRecall",
				input: { query: "cobalt", now, tediId: "tedi-a" },
			},
		);
		expect(candidates.map((row) => row.factId)).toEqual(["same-id"]);
		const hydrated = await queryOwnedMemory(
			config,
			organization,
			withoutWorkspace,
			{
				operation: "hydrateRecall",
				input: { factIds: ["same-id"], now, tediId: "tedi-a" },
			},
		);
		expect(
			SearchResultSchema.parse({
				factId: "same-id",
				score: candidates[0]!.score,
				fact: hydrated[0],
			}).fact?.visibility,
		).toBe("private");
		expect(
			await queryOwnedMemory(config, organization, withoutWorkspace, {
				operation: "hydrateRecall",
				input: { factIds: ["same-id"], now, tediId: "tedi-b" },
			}),
		).toEqual([]);
		for (const operation of ["getFact", "updateFact"] as const) {
			const request =
				operation === "getFact"
					? { operation, input: { factId: "same-id" } }
					: {
							operation,
							input: {
								factId: "same-id",
								updates: { content: "unauthorized" },
							},
						};
			await expect(
				queryOwnedMemory(config, workspace, withoutWorkspace, request),
			).rejects.toThrow("requires workspace access");
			await expect(
				queryOwnedMemory(
					config,
					personal,
					{ ...access, principalId: "principal-b" },
					request,
				),
			).rejects.toThrow("another principal");
			await expect(
				queryOwnedMemory(
					config,
					organization,
					{ ...access, organizationId: "fictional-foreign" },
					request,
				),
			).rejects.toThrow("authenticated organization");
		}
		expect(
			(
				await queryOwnedMemory(config, personal, access, {
					operation: "getFact",
					input: { factId: "same-id" },
				})
			)?.content,
		).toBe("personal cobalt decision");
		await queryOwnedMemory(config, organization, withoutWorkspace, {
			operation: "updateFact",
			input: {
				factId: "same-id",
				updates: { summary: "updated by the authorized owner" },
			},
		});
		expect(
			(
				await queryOwnedMemory(config, organization, withoutWorkspace, {
					operation: "getFact",
					input: { factId: "same-id" },
				})
			)?.summary,
		).toBe("updated by the authorized owner");
		const stub = durableObjectStubByName(
			namespace,
			env,
			memoryStoreName(organization),
		);
		expect(
			await failure(() =>
				stub.ownedMemory(personal, {
					operation: "getFact",
					input: { factId: "same-id" },
				}),
			),
		).toContain("does not match this object");
		expect(
			await failure(() =>
				stub.memory(
					{ organizationId, workspaceId: "workspace-a" },
					{ operation: "getFact", input: { factId: "same-id" } },
				),
			),
		).toContain("scope does not match this object");
	});

	it("migrates from empty and preserves ordinary, exact-topic, date-cued recall and the public schema", async () => {
		const { query } = fixture("recall");
		await query({
			operation: "createFact",
			input: {
				...fact("match"),
				topicKey: "storage/cobalt",
				sourceHash: "cobalt-hash",
			},
		});
		await query({
			operation: "createFact",
			input: {
				...fact("older"),
				content: "Previous calendar event",
				validFrom: "2026-10-01T10:00:00.000Z",
			},
		});
		for (const [id, extra] of [
			["private", { visibility: "private", tediId: "other" }],
			["archived", { archivedAt: now }],
			["rejected", { reviewStatus: "rejected" }],
			["held", { metadata: { learningFeed: { evidence: { state: "held" } } } }],
		] as const)
			await query({
				operation: "createFact",
				input: { ...fact(id), ...extra },
			});
		const candidates = await query({
			operation: "lexicalRecall",
			input: { query: "cobalt workspace", now, tediId: "tedi-a" },
		});
		expect(candidates.map((row) => row.factId)).toEqual(["match"]);
		expect(candidates[0]!.score).toBeGreaterThan(0);
		const hydrated = await query({
			operation: "hydrateRecall",
			input: {
				factIds: ["match", "private", "archived", "rejected", "held"],
				now,
				tediId: "tedi-a",
			},
		});
		expect(hydrated.map((row) => row.id)).toEqual(["match"]);
		expect(
			SearchResultSchema.parse({
				factId: "match",
				score: candidates[0]!.score,
				fact: hydrated[0],
			}).factId,
		).toBe("match");
		expect(
			(
				await query({
					operation: "topicFacts",
					input: { topicKey: "storage/cobalt" },
				})
			).map((row) => row.id),
		).toEqual(["match"]);
		expect(
			(
				await query({
					operation: "sourceFact",
					input: { sourceHash: "cobalt-hash" },
				})
			)?.id,
		).toBe("match");
		expect(
			(
				await query({
					operation: "temporalRecall",
					input: { query: "what changed yesterday", now, tediId: "tedi-a" },
				})
			).map((row) => row.factId),
		).toEqual(["match"]);
		expect(
			(
				await query({
					operation: "temporalRecall",
					input: { query: "on 2026-10-01", now },
				})
			).map((row) => row.factId),
		).toEqual(["older"]);
		await query({
			operation: "recordRecallAccess",
			input: { factIds: ["match"] },
		});
		expect(
			(await query({ operation: "getFact", input: { factId: "match" } }))
				?.accessCount,
		).toBe(1);
	});

	it("isolates workspaces in the same organization and rejects a mismatched RPC scope", async () => {
		const { scope, query } = fixture("scope");
		const other = { ...scope, workspaceId: "workspace-b" };
		await query({ operation: "createFact", input: fact("same-id") });
		expect(
			await queryMemory(config, other, {
				operation: "getFact",
				input: { factId: "same-id" },
			}),
		).toBeUndefined();
		await queryMemory(config, other, {
			operation: "createFact",
			input: { ...fact("same-id"), content: "Amber workspace" },
		});
		expect(
			(await query({ operation: "getFact", input: { factId: "same-id" } }))
				?.content,
		).toContain("Cobalt");
		const store = tenantStoreStub(namespace, env, scope);
		expect(
			await failure(() =>
				store.memory(other, {
					operation: "getFact",
					input: { factId: "same-id" },
				}),
			),
		).toContain("scope does not match");
		expect(
			await failure(() =>
				queryMemory(
					config,
					{ organizationId: scope.organizationId },
					{ operation: "getFact", input: { factId: "same-id" } },
				),
			),
		).toContain("requires workspaceId");
		expect(
			await failure(() =>
				query({
					operation: "updateFact",
					input: {
						factId: "same-id",
						updates: { organizationId: "fictional-foreign" },
					},
				}),
			),
		).toContain("organization cannot change");
	});

	it("keeps reviewed entity links, graph recall and FTS entity-name updates", async () => {
		const { query } = fixture("entity");
		const domain = await query({
			operation: "domain",
			input: { name: "migration" },
		});
		await query({
			operation: "createFact",
			input: {
				...fact("seed"),
				domainId: domain.id,
				content: "Refinery planning",
			},
		});
		await query({
			operation: "createFact",
			input: {
				...fact("hop"),
				domainId: domain.id,
				content: "Delivery deadline",
			},
		});
		const entity = await query({
			operation: "createEntity",
			input: {
				id: "entity",
				entityType: "concept",
				displayName: " Cobalt Migration ",
				now,
			},
		});
		expect(entity.normalizedName).toBe("cobalt migration");
		await query({
			operation: "recordMention",
			input: {
				id: "mention",
				occurrenceKey: "seed:1",
				sourceFactId: "seed",
				surfaceForm: "Cobalt",
				proposedType: "concept",
				extractor: "fixture",
				extractorVersion: "1",
				confidence: 0.9,
				createdAt: now,
			},
		});
		await query({
			operation: "proposeResolution",
			input: {
				id: "decision",
				clientProposalKey: "proposal",
				mentionId: "mention",
				targetEntityId: "entity",
				confidence: 0.9,
				rationale: "Exact source",
				proposedBy: { type: "external_agent", id: "fictional-proposer" },
				proposedAt: now,
			},
		});
		// An unreviewed proposal cannot affect recall.
		expect(
			await query({
				operation: "graphRecall",
				input: { query: "Cobalt Migration", now },
			}),
		).toEqual([]);
		await query({
			operation: "reviewResolution",
			input: {
				decisionId: "decision",
				expectedDecisionVersion: 0,
				outcome: "accept",
				reviewer: { type: "user", id: "fictional-reviewer" },
				reviewRationale: "Confirmed fixture",
				resolutionId: "resolution",
				reviewedAt: now,
			},
		});
		const selected = await query({ operation: "autoLinkFacts", input: {} });
		expect(
			await query({
				operation: "createAutoLink",
				input: {
					selection: {},
					edge: {
						id: "edge",
						source: selected.find((row) => row.id === "seed")!,
						target: selected.find((row) => row.id === "hop")!,
						relationType: "related_to",
						context: "same topic",
					},
				},
			}),
		).toBe(true);
		expect(
			(
				await query({
					operation: "graphRecall",
					input: { query: "Cobalt Migration", now },
				})
			)
				.map((row) => row.factId)
				.sort(),
		).toEqual(["hop", "seed"]);
		expect(
			(
				await query({
					operation: "lexicalRecall",
					input: { query: "Cobalt", now },
				})
			).map((row) => row.factId),
		).toEqual(["seed"]);
	});

	it("synchronizes citation and FTS projections and audits the workspace", async () => {
		const { query } = fixture("projections");
		await query({ operation: "createFact", input: fact("source") });
		await query({
			operation: "createFact",
			input: {
				...fact("summary"),
				source: "consolidation://observation",
				metadata: {
					consolidation: { evidence: { sources: [{ id: "source" }] } },
				},
			},
		});
		expect(
			await query({
				operation: "citationDependents",
				input: { factIds: ["source"] },
			}),
		).toEqual(["summary"]);
		await query({
			operation: "updateFact",
			input: {
				factId: "summary",
				updates: { content: "Amber harbour", metadata: {} },
			},
		});
		expect(
			await query({
				operation: "citationDependents",
				input: { factIds: ["source"] },
			}),
		).toEqual([]);
		expect(
			(
				await query({
					operation: "lexicalRecall",
					input: { query: "Amber", now },
				})
			).map((row) => row.factId),
		).toEqual(["summary"]);
		const audit = await query({
			operation: "audit",
			input: { tediId: "tedi-a", filters: { scope: "org" } },
		});
		expect(audit.counts.total).toBe(2);
		expect(audit.facts.map((row) => row.id).sort()).toEqual([
			"source",
			"summary",
		]);
	});

	it("imports memory rows atomically with scope checks and searchable projections", async () => {
		const { scope, query } = fixture("import");
		const store = tenantStoreStub(namespace, env, scope);
		const row = {
			id: "imported",
			organization_id: scope.organizationId,
			content: "Imported cobalt",
			fact_type: "technical",
			visibility: "org",
			review_status: "confirmed",
			valid_from: "2026-11-05T10:00:00.000Z",
		};
		const batch = { batchId: "facts-1", table: "memory_facts", rows: [row] };
		expect(await store.importRows(scope, batch)).toMatchObject({
			status: "imported",
			rowCount: 1,
		});
		expect(await store.importRows(scope, batch)).toMatchObject({
			status: "duplicate",
			rowCount: 1,
		});
		expect(
			(
				await query({
					operation: "lexicalRecall",
					input: { query: "cobalt", now },
				})
			).map((row) => row.factId),
		).toEqual(["imported"]);
		expect(
			await failure(() =>
				store.importRows(scope, {
					batchId: "bad-foreign",
					table: "memory_facts",
					rows: [
						{ ...row, id: "foreign", organization_id: "fictional-foreign" },
					],
				}),
			),
		).toContain("outside this workspace");
		expect(
			await failure(() =>
				store.importRows(scope, {
					batchId: "bad-duplicate",
					table: "memory_facts",
					rows: [{ ...row, id: "fresh" }, row],
				}),
			),
		).toContain("UNIQUE constraint failed");
		expect(
			await query({ operation: "getFact", input: { factId: "fresh" } }),
		).toBeUndefined();
	});

	it("serves health, expertise, curiosity and optimization state without platform tables", async () => {
		const { query } = fixture("state");
		const domain = await query({
			operation: "domain",
			input: { name: "migration" },
		});
		await query({
			operation: "createFact",
			input: { ...fact("expertise"), domainId: domain.id },
		});
		expect(
			(
				await query({
					operation: "recalculateExpertise",
					input: { tediId: "tedi-a", domainId: domain.id },
				})
			).factCount,
		).toBe(1);
		expect(
			(
				await query({
					operation: "expertise",
					input: { tediId: "tedi-a", domainId: domain.id },
				})
			)[0]?.domainName,
		).toBe("migration");
		await query({
			operation: "createCuriosity",
			input: {
				id: "curiosity",
				tediId: "tedi-a",
				topic: "Stores",
				domain: "migration",
				reason: "Inspect parity",
				source: "gap_detection",
			},
		});
		expect(
			(await query({ operation: "curiosity", input: {} })).map((row) => row.id),
		).toEqual(["curiosity"]);
		await query({
			operation: "createOptimizationSignal",
			input: {
				id: "signal",
				tediId: "tedi-a",
				type: "compiled_pattern",
				source: "self_detected",
				domain: "migration",
				evidence: ["fictional evidence"],
				suggestedAction: "Inspect workspace stores",
			},
		});
		expect(
			(await query({ operation: "optimizationSignals", input: {} })).map(
				(row) => row.id,
			),
		).toEqual(["signal"]);
		expect(
			(await query({ operation: "health", input: {} })).curiosityQueue.queued,
		).toBe(1);
		expect((await query({ operation: "stats", input: {} })).totalFacts).toBe(1);
	});
});
