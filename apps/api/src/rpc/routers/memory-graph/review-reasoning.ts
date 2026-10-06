import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import {
	agentMemoryProjectionProfileNames,
	deleteCanonicalMemoryProjection,
	reconcileCanonicalMemoryProjection,
} from "../../../integrations/cloudflare/agent-memory";
import { AUTHZ, type BaseContext, ErrorCodes, createError } from "../../orpc";
import { autoLinkFactsWithJev } from "../../../services/jev-graph-auto-linking";
import {
	countEdgesForFact,
	createEdge,
} from "@tedix/db/queries/memory-graph/edges";
import {
	createFact,
	findCurrentFactsByTopicKey,
	getFactById,
	recordFactUsage,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import {
	createGapFact,
	getGapStats,
	listGaps,
	resolveGap,
} from "@tedix/db/queries/memory-graph/gaps";
import {
	getActiveFacts,
	searchFacts,
	searchFactsWithVisibility,
} from "@tedix/db/queries/memory-graph/fact-search";
import { getMemoryHealthExtended } from "@tedix/db/queries/memory-graph/health";
import {
	getOrCreateDomain,
	listDomains,
} from "@tedix/db/queries/memory-graph/domains";
import { getTediById } from "@tedix/db/queries/tedis";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { isMemorySearchFactEligible } from "../../../services/memory-search-filter";
import { requireOrgId } from "../../org-scope";
import {
	authed,
	degradedGraphMeta,
	getCanonicalGraphFacts,
	getGraphReadState,
	hydrateGraphVisualization,
	resolveMemoryFactReviewUpdates,
	runGraphQuery,
	sanitizeViz,
} from "./policy-operations";

function reconcileFactProjection(
	context: BaseContext,
	fact: MemoryFact,
): Promise<void> {
	const work = reconcileCanonicalMemoryProjection(context.env.AGENT_MEMORY, {
		factId: fact.id,
		orgId: fact.organizationId,
		tediId: fact.tediId,
		memoryScope: fact.memoryScope,
		usePolicy: fact.usePolicy,
		reviewStatus: fact.reviewStatus,
		archivedAt: fact.archivedAt,
		validTo: fact.validTo,
		content: fact.content,
		summary: fact.summary,
		factType: fact.factType,
		confidence: fact.confidence,
	}).catch((error) => {
		console.error("[memory.lifecycle] Agent Memory reconcile failed", {
			factId: fact.id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	if (context.waitUntil) {
		context.waitUntil(work);
		return Promise.resolve();
	}
	return work;
}

function deleteFactProjection(
	context: BaseContext,
	fact: MemoryFact,
): Promise<void> {
	const work = deleteCanonicalMemoryProjection(
		context.env.AGENT_MEMORY,
		agentMemoryProjectionProfileNames({
			orgId: fact.organizationId,
			tediId: fact.tediId,
			memoryScope: fact.memoryScope,
		}),
		fact.id,
	).catch((error) => {
		console.error("[memory.lifecycle] Agent Memory delete failed", {
			factId: fact.id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	if (context.waitUntil) {
		context.waitUntil(work);
		return Promise.resolve();
	}
	return work;
}

export // =============================================================================
// PROMOTE
// =============================================================================

const promote = authed.promote
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const fact = await getFactById(context.db, input.factId);
		if (!fact) throw createError(ErrorCodes.NOT_FOUND, "Fact not found");
		if (fact.organizationId !== orgId)
			throw createError(ErrorCodes.UNAUTHORIZED, "Not your fact");
		const now = new Date().toISOString();
		const targetPriority = input.priority ?? fact.priority ?? "active";
		if (input.visibility === "org" && fact.tediId) {
			if (targetPriority === "core" && fact.domainId) {
				const coreFacts = await searchFacts(context.db, {
					orgId,
					domainId: fact.domainId,
					limit: 21,
				});
				const currentCore = coreFacts.filter((f) => f.priority === "core");
				if (currentCore.length >= 20) {
					const oldest = currentCore.sort((a, b) => {
						const aTime = a.lastAccessedAt ?? a.createdAt ?? "";
						const bTime = b.lastAccessedAt ?? b.createdAt ?? "";
						return aTime.localeCompare(bTime);
					})[0];
					if (oldest) {
						await updateFact(context.db, oldest.id, {
							priority: "active",
						});
					}
				}
			}
			const topicKey = input.topicKey ?? fact.topicKey ?? null;
			const promoted = await createFact(context.db, {
				id: crypto.randomUUID(),
				organizationId: orgId,
				tediId: null,
				domainId: fact.domainId,
				content: fact.content,
				summary: fact.summary,
				factType: fact.factType,
				confidence: fact.confidence,
				validFrom: now,
				validTo: null,
				status: "active",
				source: fact.source,
				sourceSessionId: fact.sourceSessionId,
				sourceUrl: fact.sourceUrl,
				sourceHash: fact.sourceHash,
				topicKey,
				memoryScope: "org",
				usePolicy: input.usePolicy ?? fact.usePolicy ?? "can_use_as_evidence",
				reviewStatus: input.reviewStatus ?? "confirmed",
				metadata: {
					...fact.metadata,
					memoryScope: "org",
					visibility: "org",
					promotedFrom: fact.id,
					promotedAt: now,
					...(topicKey
						? {
								topicKey,
							}
						: {}),
				},
				priority: targetPriority,
				visibility: "org",
				promotedFrom: fact.id,
				promotedAt: now,
				accessCount: 0,
				usageCount: 0,
				archivedAt: null,
				createdAt: now,
				updatedAt: now,
			});
			await createEdge(context.db, {
				id: crypto.randomUUID(),
				sourceFactId: promoted.id,
				targetFactId: fact.id,
				relationType: "promoted_from",
				strength: 1,
				context: "Validated tedi evidence promoted into org memory",
			});
			await reconcileFactProjection(context, promoted);
			if (topicKey) {
				const currentFacts = await findCurrentFactsByTopicKey(
					context.db,
					orgId,
					topicKey,
					{
						memoryScope: "org",
					},
				);
				for (const current of currentFacts) {
					if (current.id === promoted.id) continue;
					await invalidateFact(
						context.db,
						current.id,
						`Superseded by promoted fact ${promoted.id} for topic ${topicKey}`,
					);
					await updateFact(context.db, current.id, {
						reviewStatus: "superseded",
					});
					await deleteFactProjection(context, current);
					await createEdge(context.db, {
						id: crypto.randomUUID(),
						sourceFactId: promoted.id,
						targetFactId: current.id,
						relationType: "supersedes",
						strength: 1,
						context: `Topic-key supersession: ${topicKey}`,
					});
				}
			}
			return {
				fact: promoted,
			};
		}
		const updates: Record<string, unknown> = {
			visibility: input.visibility,
			promotedFrom: fact.id,
			promotedAt: now,
		};
		if (input.topicKey !== undefined) updates.topicKey = input.topicKey;
		if (input.usePolicy !== undefined) updates.usePolicy = input.usePolicy;
		if (input.reviewStatus !== undefined)
			updates.reviewStatus = input.reviewStatus;

		// If promoting to core priority, enforce max 20 core facts per domain
		if (input.priority === "core" && fact.domainId) {
			const coreFacts = await searchFacts(context.db, {
				orgId,
				domainId: fact.domainId,
				limit: 21,
			});
			const currentCore = coreFacts.filter((f) => f.priority === "core");
			if (currentCore.length >= 20) {
				// Demote the oldest (least recently accessed) core fact to active
				const oldest = currentCore.sort((a, b) => {
					const aTime = a.lastAccessedAt ?? a.createdAt ?? "";
					const bTime = b.lastAccessedAt ?? b.createdAt ?? "";
					return aTime.localeCompare(bTime);
				})[0];
				if (oldest) {
					await updateFact(context.db, oldest.id, {
						priority: "active",
					});
				}
			}
			updates.priority = "core";
		} else if (input.priority) {
			updates.priority = input.priority;
		}
		await updateFact(context.db, input.factId, updates);
		const updated = await getFactById(context.db, input.factId);
		await reconcileFactProjection(context, updated!);
		return {
			fact: updated!,
		};
	});

// =============================================================================
// REVIEW
// =============================================================================

export // =============================================================================
// REVIEW
// =============================================================================

const review = authed.review
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const fact = await getFactById(context.db, input.factId);
		if (!fact) throw createError(ErrorCodes.NOT_FOUND, "Fact not found");
		if (fact.organizationId !== orgId)
			throw createError(ErrorCodes.UNAUTHORIZED, "Not your fact");
		const reviewerTediId = input.tediId ?? context.tediId ?? null;
		if (reviewerTediId) {
			const reviewer = await getTediById(context.db, reviewerTediId);
			if (!reviewer || reviewer.organizationId !== orgId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Reviewer tedi does not belong to this organization",
				);
			}
		}
		const now = new Date().toISOString();
		const updates = resolveMemoryFactReviewUpdates(input, {
			now,
			existingMetadata: fact.metadata,
			reviewerTediId,
			reviewerAuthType: context.authType ?? null,
		});
		await updateFact(context.db, input.factId, updates);
		const updated = await getFactById(context.db, input.factId);
		await reconcileFactProjection(context, updated!);
		return {
			fact: updated!,
		};
	});

// =============================================================================
// REINDEX (admin: rebuild vector index from D1)
// =============================================================================

export // =============================================================================
// REINDEX (admin: rebuild vector index from D1)
// =============================================================================

const reindex = authed.reindex
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const startedAt = Date.now();
		let domainId: string | undefined;
		if (input.domain)
			domainId = (await getOrCreateDomain(context.db, orgId, input.domain)).id;
		const facts = await getActiveFacts(context.db, orgId, {
			tediId: input.tediId,
			domainId,
		});
		return {
			indexed: 0,
			skipped: facts.length,
			errors: 0,
			durationMs: Date.now() - startedAt,
		};
	});

// =============================================================================
// GAPS
// =============================================================================

export // =============================================================================
// GAPS
// =============================================================================

const gapsDetect = authed.gaps.detect
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const domain = await getOrCreateDomain(context.db, orgId, input.domain);

		// Get all facts in the domain
		const facts = await searchFacts(context.db, {
			orgId,
			domainId: domain.id,
			includeArchived: false,
		});

		// Get sub-domains (children of this domain)
		const allDomains = await listDomains(context.db, orgId);
		const subDomains = allDomains.filter((d) => d.parentId === domain.id);
		const gapsFound = [];

		// Check for sub-domains with zero coverage
		for (const sub of subDomains) {
			const subFacts = facts.filter((f) => f.domainId === sub.id);
			if (subFacts.length === 0) {
				const gap = await createGapFact(context.db, {
					orgId,
					tediId: input.tediId,
					domainId: domain.id,
					content: `No knowledge about sub-topic "${sub.name}" in domain "${input.domain}"`,
					metadata: {
						detectedBy: "self_test",
						severity: "moderate",
						adjacentDomains: [],
						attempts: 0,
					},
				});
				gapsFound.push(gap);
			}
		}

		// Check for low-confidence areas
		const lowConfFacts = facts.filter((f) => f.confidence < 0.5);
		if (lowConfFacts.length > 3) {
			const gap = await createGapFact(context.db, {
				orgId,
				tediId: input.tediId,
				domainId: domain.id,
				content: `${lowConfFacts.length} facts in "${input.domain}" have low confidence (<0.5) — weak area needing verification`,
				metadata: {
					detectedBy: "self_test",
					severity: lowConfFacts.length > 10 ? "critical" : "moderate",
					adjacentDomains: [],
					attempts: 0,
				},
			});
			gapsFound.push(gap);
		}

		// Check for stale facts (>90 days old without access)
		const ninetyDaysAgo = new Date(
			Date.now() - 90 * 24 * 60 * 60 * 1000,
		).toISOString();
		const staleFacts = facts.filter((f) => {
			const lastTouch =
				f.lastAccessedAt ?? f.lastVerifiedAt ?? f.createdAt ?? "";
			return lastTouch < ninetyDaysAgo;
		});
		if (staleFacts.length > 5) {
			const gap = await createGapFact(context.db, {
				orgId,
				tediId: input.tediId,
				domainId: domain.id,
				content: `${staleFacts.length} stale facts in "${input.domain}" (>90 days without access) — knowledge may be outdated`,
				metadata: {
					detectedBy: "self_test",
					severity: "minor",
					adjacentDomains: [],
					attempts: 0,
				},
			});
			gapsFound.push(gap);
		}
		return {
			gapsFound,
			domain: input.domain,
		};
	});

export const gapsList = authed.gaps.list
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		let domainId: string | undefined;
		if (input.domain) {
			const d = await getOrCreateDomain(context.db, orgId, input.domain);
			domainId = d.id;
		}
		const gaps = await listGaps(context.db, orgId, {
			domainId,
			severity: input.severity,
			tediId: input.tediId,
			limit: input.limit,
		});
		return {
			gaps,
		};
	});

export const gapsResolve = authed.gaps.resolve
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		await resolveGap(
			context.db,
			input.gapId,
			input.resolvedByFactId,
			requireOrgId(context),
		);
		return {
			success: true,
		};
	});

export const gapsReport = authed.gaps.report
	.use(AUTHZ.tedisRead)
	.handler(async ({ context }) => {
		const orgId = requireOrgId(context);
		return getGapStats(context.db, orgId);
	});

// =============================================================================
// HEALTH (Extended)
// =============================================================================

export // =============================================================================
// HEALTH (Extended)
// =============================================================================

const health = authed.health
	.use(AUTHZ.tedisRead)
	.handler(async ({ context }) => {
		const orgId = requireOrgId(context);
		return getMemoryHealthExtended(context.db, orgId);
	});

// =============================================================================
// LINK
// =============================================================================

export // =============================================================================
// LINK
// =============================================================================

const link = authed.link
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.mode === "auto") {
			let domainId: string | undefined;
			if (input.domain) {
				const d = await getOrCreateDomain(context.db, orgId, input.domain);
				domainId = d.id;
			}
			const result = await autoLinkFactsWithJev({
				db: context.db,
				env: context.env,
				context: {
					organizationId: orgId,
					tediId: context.tediId,
					runId: crypto.randomUUID(),
				},
				scope: { organizationId: orgId, tediId: context.tediId, domainId },
				dryRun: input.dryRun,
			});
			return { proposals: result.proposals };
		}

		// Manual mode
		if (!input.sourceFactId || !input.targetFactId || !input.relationType) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Manual mode requires sourceFactId, targetFactId, and relationType",
			);
		}
		// Verify both facts belong to the requesting organization
		const sourceFact = await getFactById(context.db, input.sourceFactId);
		if (!sourceFact)
			throw createError(ErrorCodes.NOT_FOUND, "Source fact not found");
		if (sourceFact.organizationId !== orgId)
			throw createError(ErrorCodes.UNAUTHORIZED, "Not your fact");
		const targetFact = await getFactById(context.db, input.targetFactId);
		if (!targetFact)
			throw createError(ErrorCodes.NOT_FOUND, "Target fact not found");
		if (targetFact.organizationId !== orgId)
			throw createError(ErrorCodes.UNAUTHORIZED, "Not your fact");
		const MAX_EDGES_PER_FACT = 20;
		const edgeCount = await countEdgesForFact(context.db, input.sourceFactId);
		if (edgeCount >= MAX_EDGES_PER_FACT) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Fact has reached max edge limit (${MAX_EDGES_PER_FACT})`,
			);
		}
		const edge = await createEdge(context.db, {
			id: crypto.randomUUID(),
			sourceFactId: input.sourceFactId,
			targetFactId: input.targetFactId,
			relationType: input.relationType,
			strength: 0.8,
			context: input.context ?? null,
		});
		return {
			edges: [edge],
		};
	});

// =============================================================================
// SYNTHESIZE
// =============================================================================

export // =============================================================================
// SYNTHESIZE
// =============================================================================

const synthesize = authed.synthesize
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const domain = await getOrCreateDomain(context.db, orgId, input.domain);
		const facts = await searchFacts(context.db, {
			orgId,
			domainId: domain.id,
			includeArchived: false,
			limit: 200,
		});

		// Group by fact type
		const grouped: Record<string, typeof facts> = {};
		for (const fact of facts) {
			const type = fact.factType;
			if (!grouped[type]) grouped[type] = [];
			grouped[type]!.push(fact);
		}
		const gaps = grouped.gap ?? [];
		const opinions = grouped.opinion ?? [];
		const decisions = grouped.decision ?? [];
		const patterns = grouped.pattern ?? [];
		const technical = grouped.technical ?? [];
		const procedural = grouped.procedural ?? [];
		const other = facts.filter(
			(f) =>
				![
					"gap",
					"opinion",
					"decision",
					"pattern",
					"technical",
					"procedural",
				].includes(f.factType),
		);

		// Build narrative
		const sections: string[] = [];
		sections.push(`## ${input.domain} Knowledge Synthesis`);
		sections.push(
			`*${facts.length} facts across ${Object.keys(grouped).length} types*\n`,
		);
		if (decisions.length > 0) {
			sections.push(`### Key Decisions (${decisions.length})`);
			for (const f of decisions) sections.push(`- ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (patterns.length > 0) {
			sections.push(`### Patterns & Gotchas (${patterns.length})`);
			for (const f of patterns) sections.push(`- ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (technical.length > 0) {
			sections.push(`### Technical Details (${technical.length})`);
			for (const f of technical) sections.push(`- ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (procedural.length > 0) {
			sections.push(`### Procedures (${procedural.length})`);
			for (const f of procedural) sections.push(`- ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (gaps.length > 0) {
			sections.push(`### Known Gaps (${gaps.length})`);
			for (const f of gaps) sections.push(`- ⚠️ ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (opinions.length > 0) {
			sections.push(`### Opinions (${opinions.length})`);
			for (const f of opinions) sections.push(`- 💭 ${f.summary ?? f.content}`);
			sections.push("");
		}
		if (other.length > 0) {
			sections.push(`### Other (${other.length})`);
			for (const f of other) sections.push(`- ${f.summary ?? f.content}`);
			sections.push("");
		}

		// Low-confidence facts as open questions
		const lowConf = facts.filter(
			(f) => f.confidence < 0.5 && f.factType !== "gap",
		);
		if (lowConf.length > 0) {
			sections.push(
				`### Open Questions (${lowConf.length} low-confidence facts)`,
			);
			for (const f of lowConf)
				sections.push(
					`- ❓ ${f.summary ?? f.content} (confidence: ${Math.round(f.confidence * 100)}%)`,
				);
		}
		return {
			domain: input.domain,
			narrative: sections.join("\n"),
			factCount: facts.length,
			gapCount: gaps.length,
		};
	});

// =============================================================================
// OPINE
// =============================================================================

export // =============================================================================
// OPINE
// =============================================================================

const opine = authed.opine
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		// An authenticated tedi principal is its own visibility scope: when the
		// caller omits tediId, derive it from the tedi JWT so the tedi still
		// sees its own private facts. Everyone else gets the least-privileged
		// org + shared read (see isMemorySearchFactEligible).
		const tediId = input.tediId ?? context.tediId;

		// D1 owns authorization and durable facts. Agent Memory recall is added
		// by the Tedi runtime as untrusted semantic context, never as an API-side
		// authorization or persistence decision.
		const d1Facts = await searchFactsWithVisibility(context.db, {
			orgId,
			visibilityTediId: tediId,
			limit: 30,
			minConfidence: 0.3,
		});
		const relevantFacts = d1Facts.map((fact) => ({
			factId: fact.id,
			score: fact.confidence,
		}));

		// Hydrate facts. getFactById applies no eligibility rules, so re-check
		// every hydrated fact against the caller's effective tedi identity —
		// a vector or D1 hit is not an authorization decision. Ineligible
		// facts (another tedi's private facts, wrong org, archived/invalidated,
		// graph anchors) are silently excluded, never errored.
		const facts = (
			await Promise.all(
				relevantFacts.map((r) => getFactById(context.db, r.factId)),
			)
		).filter(
			(f): f is Exclude<typeof f, null | undefined> =>
				f != null && isMemorySearchFactEligible(f, { orgId, tediId }),
		);

		// Classify as supporting/contradicting (simple heuristic)
		const supporting = facts.filter(
			(f) =>
				!f.content.toLowerCase().includes("but") &&
				!f.content.toLowerCase().includes("however"),
		);
		const contradicting = facts.filter(
			(f) =>
				f.content.toLowerCase().includes("but") ||
				f.content.toLowerCase().includes("however"),
		);

		// Score
		const total = supporting.length + contradicting.length || 1;
		const factSupport = supporting.length / total;
		const factRecency =
			facts.length > 0
				? facts.reduce((sum, f) => {
						const age = Date.now() - new Date(f.createdAt ?? "").getTime();
						const daysOld = age / (1000 * 60 * 60 * 24);
						return sum + Math.max(0, 1 - daysOld / 365);
					}, 0) / facts.length
				: 0;
		const contradictionPenalty = contradicting.length / total;
		const overall =
			factSupport * 0.4 +
			factRecency * 0.2 +
			(1 - contradictionPenalty) * 0.2 +
			0.5 * 0.2;
		const stance =
			overall > 0.8
				? ("strong" as const)
				: overall > 0.6
					? ("moderate" as const)
					: overall > 0.4
						? ("uncertain" as const)
						: ("conflicted" as const);

		// Build opinion content
		const opinionContent = `Opinion on: "${input.question}" — Stance: ${stance} (score: ${overall.toFixed(2)}). Based on ${supporting.length} supporting and ${contradicting.length} contradicting facts.`;

		// Determine domain from most common domain in relevant facts
		const domainCounts: Record<string, number> = {};
		for (const f of facts) {
			if (f.domainId)
				domainCounts[f.domainId] = (domainCounts[f.domainId] ?? 0) + 1;
		}
		const topDomainId = Object.entries(domainCounts).sort(
			(a, b) => b[1] - a[1],
		)[0]?.[0];

		// Store as opinion fact
		const opinion = await createFact(context.db, {
			id: crypto.randomUUID(),
			organizationId: orgId,
			tediId: tediId ?? null,
			domainId: topDomainId ?? null,
			content: opinionContent,
			factType: "opinion",
			confidence: overall,
			source: "reflection",
			metadata: {
				question: input.question,
				supportingFactIds: supporting.map((f) => f.id),
				contradictingFactIds: contradicting.map((f) => f.id),
				confidenceBreakdown: {
					factSupport,
					factRecency,
					contradictionPenalty,
					domainExpertise: 0.5,
				},
				stance,
				lastReviewed: new Date().toISOString(),
			},
			visibility: tediId ? "private" : "org",
			accessCount: 0,
		});
		return {
			opinion,
			stance,
			supportingCount: supporting.length,
			contradictingCount: contradicting.length,
		};
	});

// =============================================================================
// FEEDBACK (retrieval→usage correlation)
// =============================================================================

export // =============================================================================
// FEEDBACK (retrieval→usage correlation)
// =============================================================================

const feedback = authed.feedback
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const updated = await recordFactUsage(
			context.db,
			input.factIds,
			input.signal,
		);
		return {
			updated,
		};
	});

// =============================================================================
// GRAPH DB QUERIES (Neo4j-powered)
// =============================================================================

export const graphVisualization = authed.graph.visualization
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(
			context,
			input.view === "knowledge_map" && !input.centerFactId
				? {
						requiresGds: true,
					}
				: undefined,
		);
		if (meta.degraded || !graphClient)
			return {
				nodes: [],
				edges: [],
				meta,
			};
		switch (input.view) {
			case "knowledge_map":
				try {
					const visualization = await graphClient.getVisualization({
						orgId,
						tediId: input.tediId,
						domainId: input.domainId,
						centerFactId: input.centerFactId,
						depth: input.depth,
						maxNodes: input.maxNodes,
					});
					return {
						...(await hydrateGraphVisualization(context, orgId, visualization)),
						meta,
					};
				} catch (e) {
					console.warn("[GraphDB] graphVisualization knowledge_map failed:", e);
					return {
						nodes: [],
						edges: [],
						meta: degradedGraphMeta(meta),
					};
				}
			case "decision_trace": {
				if (!input.decisionId)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"decisionId is required for decision_trace view",
					);
				try {
					const { decisionTrace } =
						await import("../../../integrations/graph-db/queries/visualization");
					const records = await runGraphQuery(
						context,
						decisionTrace(input.decisionId, orgId),
					);
					if (records.length === 0)
						return {
							nodes: [],
							edges: [],
							meta,
						};
					const r = records[0]!;
					return {
						...(await hydrateGraphVisualization(context, orgId, {
							nodes: (r.nodes ?? []) as unknown[],
							edges: (r.edges ?? []) as unknown[],
						})),
						meta,
					};
				} catch (e) {
					console.warn(
						"[GraphDB] graphVisualization decision_trace failed:",
						e,
					);
					return {
						nodes: [],
						edges: [],
						meta: degradedGraphMeta(meta),
					};
				}
			}
			case "expertise_radar": {
				const tediId = input.tediId ?? context.tediId;
				if (!tediId)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"tediId is required for expertise_radar view",
					);
				try {
					const { expertiseRadar } =
						await import("../../../integrations/graph-db/queries/visualization");
					const records = await runGraphQuery(
						context,
						expertiseRadar(tediId, orgId),
					);
					if (records.length === 0)
						return {
							nodes: [],
							edges: [],
							meta,
						};
					const r = records[0]!;
					return {
						...sanitizeViz({
							nodes: (r.nodes ?? []) as unknown[],
							edges: (r.edges ?? []) as unknown[],
						}),
						meta,
					};
				} catch (e) {
					console.warn(
						"[GraphDB] graphVisualization expertise_radar failed:",
						e,
					);
					return {
						nodes: [],
						edges: [],
						meta: degradedGraphMeta(meta),
					};
				}
			}
			case "cross_tedi": {
				try {
					const { crossTediFlow } =
						await import("../../../integrations/graph-db/queries/visualization");
					const records = await runGraphQuery(context, crossTediFlow(orgId));
					if (records.length === 0)
						return {
							nodes: [],
							edges: [],
							meta,
						};
					const r = records[0]!;
					return {
						...sanitizeViz({
							nodes: (r.nodes ?? []) as unknown[],
							edges: (r.edges ?? []) as unknown[],
						}),
						meta,
					};
				} catch (e) {
					console.warn("[GraphDB] graphVisualization cross_tedi failed:", e);
					return {
						nodes: [],
						edges: [],
						meta: degradedGraphMeta(meta),
					};
				}
			}
			default:
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Unknown view: ${input.view}`,
				);
		}
	});

export const graphSimilar = authed.graph.similar
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context, {
			requiresGds: true,
		});
		if (meta.degraded || !graphClient)
			return {
				results: [],
				meta,
			};
		try {
			const results = await graphClient.findStructurallySimilar(
				input.factId,
				orgId,
				input.topK,
			);
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				results.map((result) => result.factId),
			);
			const allowed = new Set(canonical.map((fact) => fact.id));
			return {
				results: results.filter((result) => allowed.has(result.factId)),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] findStructurallySimilar handler failed:", e);
			return {
				results: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphPath = authed.graph.path
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context);
		if (meta.degraded || !graphClient)
			return {
				path: null,
				meta,
			};
		try {
			const path = await graphClient.findPath(
				input.factIdA,
				input.factIdB,
				orgId,
				input.maxHops,
			);
			if (!path)
				return {
					path,
					meta,
				};
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				path.factIds,
			);
			if (canonical.length !== new Set(path.factIds).size) {
				return {
					path: null,
					meta: degradedGraphMeta(meta),
				};
			}
			return {
				path,
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] findPath handler failed:", e);
			return {
				path: null,
				meta: degradedGraphMeta(meta),
			};
		}
	});
