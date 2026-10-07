import {
	createEdge,
	getEdgesForFacts,
	getRelatedFactsForFacts,
} from "@tedix/db/queries/memory-graph/edges";
import { AUTHZ, ErrorCodes, createError } from "../../orpc";
import {
	type FactType,
	createFact,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
	getFactsByIds,
	recordFactAccess,
	recordFactVerification,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import {
	archiveLowConfidence,
	boostConfidence,
	decayConfidence,
	invalidateFact,
	resetCollapsedConfidence,
} from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { assembleContext } from "../../../services/memory-graph-context-assembly";
import { auditMemoryGraph } from "@tedix/db/queries/memory-audit";
import {
	buildBrainWriteQualityEnvelope,
	mergeBrainWriteMetadata,
	shouldEnforceFactAdmission,
} from "../../../services/brain-write-quality";
import {
	evaluateMemoryQuality,
	extractMemoryQualityEvidence,
	memoryQualityDisposition,
	memorySourceEvidenceHash,
	shouldEvaluateAfterTurnMemory,
} from "../../../services/jev-memory-quality";
import { resolveMemoryJudgmentRoute } from "../../../services/jev-memory-policy";
import {
	countFacts,
	searchFacts,
} from "@tedix/db/queries/memory-graph/fact-search";
import {
	countLinkableSameDomainFacts,
	evaluateFactAdmission,
} from "@tedix/db/queries/fact-lifecycle";
import { episodeTraceId } from "../../episode-trace";
import {
	getExpertise,
	recalculateExpertise,
} from "@tedix/db/queries/memory-graph/expertise";
import { getMemoryGraphStats } from "@tedix/db/queries/memory-graph/stats";
import {
	getOrCreateDomain,
	listDomains,
} from "@tedix/db/queries/memory-graph/domains";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	insertRuntimeEvent,
	resolveTediRuntimeBackend,
} from "../cognitive-runtime/events-policy";
import { isMemorySearchFactEligible } from "../../../services/memory-search-filter";
import { requireOrgId } from "../../org-scope";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	authed,
	cheapHash,
	deriveTopicKey,
	getContextAssemblyGraphClient,
	getHeader,
	logMemorySearch,
	measureSearchPhase,
	resolveMemoryFactOwnership,
	resolveMemoryScope,
	resolveReviewStatus,
	resolveUsePolicy,
} from "./policy-operations";
import {
	agentMemoryProjectionProfileNames,
	deleteCanonicalMemoryProjection,
	reconcileCanonicalMemoryProjection,
	recallCanonicalMemoryCandidates,
} from "../../../integrations/cloudflare/agent-memory";

export // =============================================================================
// SEARCH
// =============================================================================

const search = authed.search
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const {
			query: rawQuery,
			topicKey: rawTopicKey,
			tediId: inputTediId,
			domain,
			factType,
			minConfidence,
			topK,
			includeRelated,
			includeGraphAnchors,
		} = input;
		// An authenticated tedi principal is its own visibility scope: when the
		// caller omits tediId, derive it from the tedi JWT so the tedi still
		// sees its own private facts. Everyone else gets the least-privileged
		// org + shared read (see isMemorySearchFactEligible).
		const tediId = inputTediId ?? context.tediId;
		const topicKey = rawTopicKey?.trim() || undefined;
		const query = rawQuery?.trim() || topicKey || "";
		const requestedTopK = topK ?? 10;
		const timings: Record<string, number> = {};
		const traceId = episodeTraceId(context.headers) ?? crypto.randomUUID();
		const searchStartedAt = Date.now();
		logMemorySearch(context, "start", {
			traceId,
			authType: context.authType,
			caller: getHeader(context, "X-Tedix-Caller"),
			callerSource: getHeader(context, "X-Tedix-Caller-Source"),
			contextTediId: context.tediId,
			inputTediId,
			effectiveTediId: tediId,
			orgId,
			origin: getHeader(context, "Origin"),
			referer: getHeader(context, "Referer"),
			userAgent: getHeader(context, "User-Agent"),
			queryLength: query.length,
			topicKey,
			topK: requestedTopK,
			includeRelated: Boolean(includeRelated),
			domain,
			factType,
		});

		// Resolve domain name to ID if provided
		if (input.tediId) {
			const tedi = await getTediById(context.db, input.tediId);
			if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
			if (tedi.organizationId !== orgId) {
				throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
			}
		}
		let domainId: string | undefined;
		if (domain) {
			const d = await measureSearchPhase(timings, "domainMs", () =>
				getOrCreateDomain(context.db, orgId, domain),
			);
			domainId = d.id;
		}

		// Agent Memory supplies candidate IDs only. D1 remains authoritative for
		// tenant ownership, lifecycle, visibility, confidence, and returned text.
		let results: Array<{ factId: string; score: number }> = [];
		let retrievalBackend = "d1_topic";
		let recallOutcome = "matched";
		if (topicKey) {
			const topicFacts = await measureSearchPhase(timings, "topicKeyD1Ms", () =>
				findCurrentFactsByTopicKey(context.db, orgId, topicKey),
			);
			results = topicFacts.map((fact) => ({ factId: fact.id, score: 1 }));
		}
		if (results.length === 0 && query) {
			retrievalBackend = "agent_memory";
			try {
				results = await measureSearchPhase(timings, "agentMemoryMs", () =>
					recallCanonicalMemoryCandidates(context.env.AGENT_MEMORY, {
						orgId,
						tediId,
						query,
						limit: Math.max(requestedTopK * 2, requestedTopK),
					}),
				);
				recallOutcome = results.length > 0 ? "matched" : "empty";
			} catch (error) {
				recallOutcome = "error";
				console.error("[memory.search] Agent Memory recall failed", {
					orgId,
					tediId: tediId ?? null,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		// Empty or failed semantic recall stays empty. A confidence-ranked D1
		// inventory is not a query match and must not masquerade as relevant memory.
		const candidateLimit = Math.min(
			results.length,
			Math.max(requestedTopK * 2, requestedTopK),
		);
		const candidateResults = results.slice(0, candidateLimit);
		const facts = await measureSearchPhase(timings, "hydrateFactsMs", () =>
			getFactsByIds(
				context.db,
				candidateResults.map((r) => r.factId),
				{
					includeGraphAnchors,
				},
			),
		);
		const factById = new Map(facts.map((fact) => [fact.id, fact]));
		const hydratedResults = candidateResults
			.map((r) => {
				const fact = factById.get(r.factId);
				if (!fact) return null;
				if (
					!isMemorySearchFactEligible(fact, {
						orgId,
						tediId,
						domainId,
						factType: factType as FactType | undefined,
						minConfidence,
						includeGraphAnchors,
					})
				) {
					return null;
				}
				return {
					factId: r.factId,
					score: r.score,
					fact,
				};
			})
			.filter((r): r is NonNullable<typeof r> => r !== null)
			.slice(0, requestedTopK);
		const relatedFactsByFactId = includeRelated
			? await measureSearchPhase(timings, "relatedFactsMs", () =>
					getRelatedFactsForFacts(
						context.db,
						hydratedResults.map((r) => r.factId),
					),
				)
			: undefined;
		const searchResults = hydratedResults.map((result) => {
			const relatedFacts = relatedFactsByFactId?.get(result.factId);
			return {
				...result,
				...(relatedFacts
					? {
							relatedFacts,
						}
					: {}),
			};
		});
		void Promise.allSettled(
			searchResults.flatMap((result) => [
				recordFactAccess(context.db, result.factId),
				boostConfidence(context.db, [result.factId], 1.05),
			]),
		);
		const total = await measureSearchPhase(timings, "countFactsMs", () =>
			countFacts(context.db, orgId),
		);
		logMemorySearch(context, "complete", {
			traceId,
			totalMs: Date.now() - searchStartedAt,
			...timings,
			rawResultCount: results.length,
			candidateCount: candidateResults.length,
			hydratedCount: hydratedResults.length,
			returnedCount: searchResults.length,
			relatedExpanded: Boolean(includeRelated),
			selectedFactIds: searchResults.map((result) => result.factId),
			retrievalBackend,
			recallOutcome,
			contentBackend: "d1",
		});

		// Brain retrieval span + memory.retrieved event — put each retrieval on
		// the runtime spine so a decision episode can show what was retrieved (and,
		// once cited/ignored signals land, what was used). Privacy: the raw query
		// is hashed, not stored. Tedi-scoped retrievals only.
		if (tediId) {
			context.waitUntil?.(
				resolveTediRuntimeBackend(context, tediId)
					.then((runtimeBackend) =>
						insertRuntimeEvent(context, {
							organizationId: orgId,
							tediId,
							kind: "memory.retrieved",
							runtimeBackend,
							runtimeMetadata: {
								traceId,
							},
							payload: {
								traceId,
								queryHash: cheapHash(query),
								topK: requestedTopK,
								retrievalBackend,
								recallOutcome,
								contentBackend: "d1",
								agentMemoryMs: timings.agentMemoryMs ?? null,
								hydrateFactsMs: timings.hydrateFactsMs ?? null,
								rawResultCount: results.length,
								hydratedCount: hydratedResults.length,
								returnedCount: searchResults.length,
								factIds: searchResults.map((r) => r.factId),
							},
							createdAt: new Date().toISOString(),
						}),
					)
					.catch((err) =>
						console.warn(
							"[CognitiveBridge] memory.retrieved emit failed:",
							err,
						),
					),
			);
		}
		return {
			results: searchResults,
			totalFacts: total,
			query,
		};
	});

// =============================================================================
// AUDIT
// =============================================================================

export // =============================================================================
// AUDIT
// =============================================================================

const audit = authed.audit
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"memory audit requires a tediId or authenticated tedi context",
			);
		}
		const tedi = await getTediById(context.db, tediId);
		if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		if (tedi.organizationId !== orgId) {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
		return auditMemoryGraph(
			{
				db: context.env.DB,
				organizationId: orgId,
				tediId,
			},
			{
				scope: input.scope,
				topic_key_state: input.topicKeyState,
				review_status: input.reviewStatus,
				priority: input.priority,
				use_policy: input.usePolicy,
				fact_type: input.factType,
				status: input.status,
				source_session_id: input.sourceSessionId,
				source_prefix: input.sourcePrefix,
				producer: input.producer,
				search: input.search,
				include_archived: input.includeArchived,
				limit: input.limit,
				offset: input.offset,
				order_by: input.orderBy,
			},
		);
	});

// =============================================================================
// LEARN
// =============================================================================

export // =============================================================================
// LEARN
// =============================================================================

const learn = authed.learn
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const now = new Date().toISOString();

		// Provenance: when this learn comes from a skill workflow (skill-runtime
		// sets X-Tedix-Skill-Run-Id), the run URI is the authoritative source.
		// It overrides input.source — including stub defaults like "session"
		// injected by the MCP `memory_learn` tool's staticParams — because a
		// workflow run is a stronger provenance anchor than any caller-supplied
		// label. The runId resolves back to the skill_runs row for ownership
		// and artifact lookup, so revoke can later cascade-delete facts whose
		// source matches this prefix.
		const skillRunId = context.headers.get("X-Tedix-Skill-Run-Id");
		const resolvedSource = skillRunId
			? `skill://runs/${skillRunId}`
			: (input.source ?? null);

		// Content-hash dedup: SHA-256 of normalized content catches exact/near-exact duplicates
		// before D1 insert — prevents the 34x duplicate problem from parallel observation cycles.
		const contentHash = await crypto.subtle
			.digest(
				"SHA-256",
				new TextEncoder().encode(input.content.trim().toLowerCase()),
			)
			.then((buf) =>
				[...new Uint8Array(buf)]
					.map((b) => b.toString(16).padStart(2, "0"))
					.join(""),
			);
		const existingByHash = await findFactBySourceHash(
			context.db,
			orgId,
			contentHash,
		);
		if (existingByHash) {
			// Exact duplicate — boost existing fact instead of creating a new one
			await recordFactVerification(context.db, existingByHash.id, 1.02);
			const reprojection = reconcileCanonicalMemoryProjection(
				context.env.AGENT_MEMORY,
				{
					factId: existingByHash.id,
					orgId,
					tediId: existingByHash.tediId,
					memoryScope: existingByHash.memoryScope,
					usePolicy: existingByHash.usePolicy,
					reviewStatus: existingByHash.reviewStatus,
					archivedAt: existingByHash.archivedAt,
					validTo: existingByHash.validTo,
					content: existingByHash.content,
					summary: existingByHash.summary,
					factType: existingByHash.factType,
					confidence: existingByHash.confidence,
				},
			).catch((error) => {
				console.error("[memory.learn] duplicate reprojection failed", {
					orgId,
					factId: existingByHash.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			if (context.waitUntil) context.waitUntil(reprojection);
			else await reprojection;
			return {
				fact: existingByHash,
				domain: {
					id: existingByHash.domainId,
				},
				edges: [],
				invalidated: [],
				deduplicated: true,
			};
		}

		// Get or create domain
		const domain = await getOrCreateDomain(context.db, orgId, input.domain);

		// Create the canonical fact in D1 before any managed projection call.
		const factId = crypto.randomUUID();
		const { evidence: sourceEvidence, metadata: inputMetadata } =
			extractMemoryQualityEvidence(input.metadata, input.sourceEvidence);
		const forwardedTediId =
			getHeader(context, "x-tedix-auth-tedi-id") ??
			getHeader(context, "x-tedix-tedi-id");
		const memoryScope = resolveMemoryScope({
			memoryScope: input.memoryScope,
			tediId: input.tediId ?? context.tediId ?? forwardedTediId,
			metadata: inputMetadata ?? undefined,
		});
		const usePolicy = resolveUsePolicy(
			{
				usePolicy: input.usePolicy,
				metadata: inputMetadata ?? undefined,
			},
			memoryScope,
		);
		const reviewStatus = resolveReviewStatus({
			reviewStatus: input.reviewStatus,
			metadata: inputMetadata ?? undefined,
			memoryScope,
			usePolicy,
		});
		const topicKey = deriveTopicKey(
			{
				topicKey: input.topicKey,
				metadata: inputMetadata ?? undefined,
			},
			orgId,
		);
		const ownership = resolveMemoryFactOwnership({
			memoryScope,
			inputTediId: input.tediId,
			contextTediId: context.tediId,
			forwardedTediId,
			visibility: input.visibility,
		});
		const factTediId = ownership.tediId;
		const visibility = ownership.visibility;
		// Only the trusted runtime bridge supplies the turn the Observer saw: the
		// user turn, the assistant reply and content-free tool receipts. The
		// observer's generated fact never grounds itself. An absent/oversized
		// excerpt performs no paid call and makes no claim of semantic support.
		// This verdict can only restrict; it cannot grant any memory authority.
		// Shadow (the default) judges after the insert and only records the
		// verdict; enforce is an explicit tenant opt-in that gates the row inline.
		const memoryQualityRoute =
			sourceEvidence.trim() &&
			shouldEvaluateAfterTurnMemory({
				source: resolvedSource ?? null,
				producer: inputMetadata?.producer,
				authType: context.authType,
				forwardedTediId: forwardedTediId ?? null,
			})
				? await resolveMemoryJudgmentRoute(context.db, orgId, "memoryQuality")
				: null;
		const judgeMemoryQuality = memoryQualityRoute
			? () =>
					evaluateMemoryQuality({
						fact: input.content,
						evidence: sourceEvidence,
						db: context.db,
						env: context.env,
						context: {
							organizationId: orgId,
							tediId: factTediId ?? undefined,
							runId: episodeTraceId(context.headers) ?? undefined,
						},
						route: memoryQualityRoute,
					})
			: null;
		const memoryQuality =
			judgeMemoryQuality && memoryQualityRoute?.mode === "enforce"
				? memoryQualityDisposition(await judgeMemoryQuality())
				: null;
		const memoryEvidenceHash = memoryQuality
			? await memorySourceEvidenceHash(sourceEvidence)
			: null;
		const memoryUsePolicy = memoryQuality?.restrict
			? "do_not_inject_automatically"
			: usePolicy;
		const memoryReviewStatus = memoryQuality?.restrict
			? "restricted"
			: reviewStatus;
		const writeQuality = buildBrainWriteQualityEnvelope({
			content: input.content,
			domain: input.domain,
			confidence: input.confidence,
			priority: memoryScope === "graph" ? "background" : input.priority,
			source: resolvedSource,
			sourceSessionId: input.sourceSessionId ?? null,
			sourceUrl: input.sourceUrl ?? null,
			sourceHash: contentHash,
			metadata: inputMetadata,
		});
		// Graph-linkage admission gate: a candidate fact must dedupe/link
		// against existing facts/entities (explicit relatedTo edges, a stable
		// topic key, or a cheap same-domain token-overlap match) to enter at
		// normal confidence. Unlinked novel facts still enter, but as short-TTL
		// probation with capped confidence — enforced by AUTHENTICATED caller
		// class (any agent-authenticated write, plus afterTurn for every caller;
		// see shouldEnforceFactAdmission), never by caller-controlled payload
		// labels alone. Operators/API keys keep the labeled-producer behavior
		// and otherwise get the linkage stamp only. No embedding calls run on
		// this synchronous path; the deferred vector pass below upgrades
		// unlinked → linked when similarity finds neighbours.
		const supersessionTargets = topicKey
			? await findCurrentFactsByTopicKey(context.db, orgId, topicKey, {
					memoryScope,
				})
			: [];
		const relatedFactCount = input.relatedTo?.length ?? 0;
		const similarSameDomainCount =
			relatedFactCount === 0 && !topicKey
				? await countLinkableSameDomainFacts(
						context.db,
						orgId,
						domain.id,
						input.content,
					)
				: 0;
		const admission = evaluateFactAdmission(
			{
				relatedFactCount,
				topicKeyMatches: supersessionTargets.length,
				hasTopicKey: Boolean(topicKey),
				similarSameDomainCount,
			},
			{
				enforced: shouldEnforceFactAdmission(
					{
						authType: context.authType,
						contextTediId: context.tediId ?? null,
						forwardedTediId: forwardedTediId ?? null,
					},
					writeQuality.sourceKind,
				),
				now,
			},
		);
		const admittedConfidence =
			admission.confidenceCeiling !== null
				? Math.min(writeQuality.confidenceApplied, admission.confidenceCeiling)
				: writeQuality.confidenceApplied;
		const qualityConfidence = memoryQuality?.restrict
			? Math.min(admittedConfidence, 0.55)
			: admittedConfidence;
		const metadata = mergeBrainWriteMetadata(
			{
				...inputMetadata,
				...(topicKey
					? {
							topicKey,
						}
					: {}),
				memoryScope,
				usePolicy: memoryUsePolicy,
				reviewStatus: memoryReviewStatus,
				...(memoryQuality
					? {
							memoryQuality: {
								...memoryQuality.quality,
								sourceEvidenceSha256: memoryEvidenceHash,
							},
						}
					: {}),
				brainAdmission: admission,
			},
			writeQuality,
		);
		const fact = await createFact(context.db, {
			id: factId,
			organizationId: orgId,
			tediId: factTediId,
			domainId: domain.id,
			content: input.content,
			summary: input.summary ?? null,
			factType: input.factType,
			confidence: qualityConfidence,
			validTo: null,
			archivedAt: null,
			priority: writeQuality.priorityApplied,
			status: "probation",
			validFrom: now,
			source: resolvedSource,
			sourceSessionId: input.sourceSessionId ?? null,
			sourceUrl: input.sourceUrl ?? null,
			sourceHash: contentHash,
			topicKey,
			memoryScope,
			usePolicy: memoryUsePolicy,
			reviewStatus: memoryReviewStatus,
			metadata: toJsonRecord(metadata),
			visibility,
			accessCount: 0,
		});
		if (judgeMemoryQuality && memoryQualityRoute?.mode === "shadow") {
			const shadowJudgment = judgeMemoryQuality()
				.then((verdict) =>
					console.info("[memory.learn] memory quality shadow verdict", {
						orgId,
						factId,
						verdict,
						wouldRestrict: memoryQualityDisposition(verdict).restrict,
						model: memoryQualityRoute.model,
					}),
				)
				.catch((error) =>
					console.warn("[memory.learn] memory quality shadow judgment failed", {
						orgId,
						factId,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			if (context.waitUntil) context.waitUntil(shadowJudgment);
			else await shadowJudgment;
		}

		// Cognitive-event bridge — put the new memory fact on the runtime
		// spine so a decision episode can show what the tedi learned. Tedi-scoped
		// facts only (org-level facts have no tediId).
		if (factTediId) {
			const episodeTrace = episodeTraceId(context.headers);
			const observedTediId = factTediId;
			context.waitUntil?.(
				resolveTediRuntimeBackend(context, observedTediId)
					.then((runtimeBackend) =>
						insertRuntimeEvent(context, {
							organizationId: orgId,
							tediId: observedTediId,
							kind: "memory.observed",
							runtimeBackend,
							...(episodeTrace
								? {
										runtimeMetadata: {
											traceId: episodeTrace,
										},
									}
								: {}),
							payload: {
								factId,
								factType: input.factType,
								domainId: domain.id,
								confidence: qualityConfidence,
							},
							createdAt: now,
						}),
					)
					.catch((err) =>
						console.warn("[CognitiveBridge] memory.observed emit failed:", err),
					),
			);
		}

		// Create edges synchronously (D1 only, fast)
		//
		// `rel.factId` is raw caller input and every READ above is org-bound, so
		// this write was the one unbound path: an edge could be pointed at any
		// organization's fact, grafting a foreign node into this org's graph (and
		// exposing it to traversal/visualisation, which follow edges). Resolve the
		// targets under the caller's org first and reject anything that does not
		// belong — one batched read rather than a per-edge round trip.
		const edges = [];
		if (input.relatedTo?.length) {
			const targetIds = [...new Set(input.relatedTo.map((rel) => rel.factId))];
			const reachable = new Set(
				(await getFactsByIds(context.db, targetIds))
					.filter((fact) => fact.organizationId === orgId)
					.map((fact) => fact.id),
			);
			const foreign = targetIds.filter((id) => !reachable.has(id));
			if (foreign.length > 0) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Related fact not found: ${foreign.join(", ")}`,
				);
			}
		}
		if (input.relatedTo) {
			for (const rel of input.relatedTo) {
				const edge = await createEdge(context.db, {
					id: crypto.randomUUID(),
					sourceFactId: factId,
					targetFactId: rel.factId,
					relationType: rel.relationType,
					strength: 0.8,
					context: rel.context ?? null,
				});
				edges.push(edge);
			}
		}
		const invalidated: Array<{
			factId: string;
			summary: string | null;
		}> = [];
		if (topicKey) {
			// Supersession targets were prefetched for the admission gate above
			// (before this fact existed, so no self-filter is needed).
			for (const existingFact of supersessionTargets) {
				await invalidateFact(
					context.db,
					existingFact.id,
					`Superseded by ${factId} for topic ${topicKey}`,
				);
				await updateFact(context.db, existingFact.id, {
					reviewStatus: "superseded",
				});
				const supersedesEdge = await createEdge(context.db, {
					id: crypto.randomUUID(),
					sourceFactId: factId,
					targetFactId: existingFact.id,
					relationType: "supersedes",
					strength: 1,
					context: `Topic-key supersession: ${topicKey}`,
				});
				edges.push(supersedesEdge);
				invalidated.push({
					factId: existingFact.id,
					summary: existingFact.summary,
				});
			}
		}

		// Exact source hashes and topic keys own canonical deduplication. Agent
		// Memory recall is untrusted and never mutates D1 lifecycle state.
		const projectionWork = (async () => {
			for (const existingFact of supersessionTargets) {
				await deleteCanonicalMemoryProjection(
					context.env.AGENT_MEMORY,
					agentMemoryProjectionProfileNames({
						orgId,
						tediId: existingFact.tediId,
						memoryScope: existingFact.memoryScope,
					}),
					existingFact.id,
				);
			}
			await reconcileCanonicalMemoryProjection(context.env.AGENT_MEMORY, {
				factId,
				orgId,
				tediId: factTediId,
				memoryScope,
				usePolicy: memoryUsePolicy,
				reviewStatus: memoryReviewStatus,
				archivedAt: fact.archivedAt,
				validTo: fact.validTo,
				content: fact.content,
				summary: fact.summary,
				factType: fact.factType,
				confidence: fact.confidence,
			});
		})();
		const loggedProjection = projectionWork.catch((error) => {
			console.error("[memory.learn] Agent Memory projection failed", {
				orgId,
				factId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		if (context.waitUntil) context.waitUntil(loggedProjection);
		else await loggedProjection;
		// Auto-recalculate expertise in the background. D1 triggers project the
		// resulting expertise row through the durable outbox.
		if (factTediId) {
			const expertiseWork = (async () => {
				try {
					await recalculateExpertise(context.db, factTediId, domain.id);
				} catch (e) {
					console.warn("[MemoryGraph] Expertise recalculation failed:", e);
				}
			})();
			if (context.waitUntil) {
				context.waitUntil(expertiseWork);
			}
		}
		return {
			fact,
			edges,
			embeddingId: null,
			invalidated: invalidated.length > 0 ? invalidated : undefined,
		};
	});

// =============================================================================
// REFLECT
// =============================================================================

export // =============================================================================
// REFLECT
// =============================================================================

const reflect = authed.reflect
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		if (input.scope === "domain" && !input.domain?.trim()) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"domain is required for scope=domain",
			);
		}
		const tediId = input.tediId;
		const domainId = input.domain
			? (await getOrCreateDomain(context.db, orgId, input.domain)).id
			: undefined;
		// Match the existing workflow's bounded fact selection, including its
		// shared search ordering. Never scan every domain for a recent request.
		const selectedFacts = await searchFacts(context.db, {
			orgId,
			tediId,
			domainId,
			limit: input.scope === "full" ? 500 : 100,
		});
		const factIds = selectedFacts.map((fact) => fact.id);
		const filterOpts = { tediId, domainId, factIds };

		// Detect and fix confidence collapse before doing anything else
		const resetCount = await resetCollapsedConfidence(
			context.db,
			orgId,
			0.8,
			factIds,
		);
		if (resetCount > 0) {
			console.warn(
				`[MemoryGraph] Reset ${resetCount} facts from confidence collapse`,
			);
		}
		const totalBefore = selectedFacts.length;
		// Time-based decay: only stale facts, max once/day per fact
		const decayed = await decayConfidence(
			context.db,
			orgId,
			0.99,
			0.1,
			filterOpts,
		);
		const { count: archivedCount, archivedIds } = await archiveLowConfidence(
			context.db,
			orgId,
			0.2,
			filterOpts,
		);

		// Create edges between unlinked facts in the same domain
		let edgesCreated = 0;
		const MAX_NEW_EDGES = 5;
		const archived = new Set(archivedIds);
		const domainGroups = new Map<string, typeof selectedFacts>();
		for (const fact of selectedFacts) {
			if (!fact.domainId || archived.has(fact.id)) continue;
			const group = domainGroups.get(fact.domainId) ?? [];
			// Preserve the existing per-domain cap; one batch then needs at
			// most 100 bound IDs across the helper's two edge directions.
			if (group.length < 50) group.push(fact);
			domainGroups.set(fact.domainId, group);
		}
		const allDomains = domainGroups.size
			? await listDomains(context.db, orgId)
			: [];
		for (const [domainId, domainFacts] of domainGroups) {
			if (edgesCreated >= MAX_NEW_EDGES) break;
			if (domainFacts.length < 2) continue;
			const domain = allDomains.find((domain) => domain.id === domainId);
			if (!domain) continue;
			const edges = await getEdgesForFacts(
				context.db,
				domainFacts.map((fact) => fact.id),
			);
			const linkedPairs = new Set(
				edges.map((edge) =>
					[edge.sourceFactId, edge.targetFactId].sort().join(":"),
				),
			);

			// Find unlinked pairs and create edges (up to cap)
			for (
				let i = 0;
				i < domainFacts.length && edgesCreated < MAX_NEW_EDGES;
				i++
			) {
				for (
					let j = i + 1;
					j < domainFacts.length && edgesCreated < MAX_NEW_EDGES;
					j++
				) {
					const pairKey = [domainFacts[i]!.id, domainFacts[j]!.id]
						.sort()
						.join(":");
					if (!linkedPairs.has(pairKey)) {
						await createEdge(context.db, {
							id: crypto.randomUUID(),
							sourceFactId: domainFacts[i]!.id,
							targetFactId: domainFacts[j]!.id,
							relationType: "related_to",
							strength: 0.5,
							context: `same_domain:${domain.name}`,
						});
						linkedPairs.add(pairKey);
						edgesCreated++;
					}
				}
			}
		}

		// Recalculate expertise per domain; D1 triggers project the changes.
		let expertiseUpdated = 0;
		if (tediId) {
			for (const domain of allDomains.filter((domain) =>
				domainGroups.has(domain.id),
			)) {
				try {
					await recalculateExpertise(context.db, tediId, domain.id);
					expertiseUpdated++;
				} catch (e) {
					console.warn(
						"[MemoryGraph] Expertise recalculation failed for domain:",
						domain.id,
						e,
					);
				}
			}
		}
		return {
			factsReviewed: totalBefore,
			edgesCreated,
			factsArchived: archivedCount,
			confidenceUpdated: decayed,
			summary: `Reviewed ${totalBefore} facts. Decayed ${decayed} stale facts (×0.99/day, 7d threshold). Archived ${archivedCount} low-confidence facts.${edgesCreated > 0 ? ` Created ${edgesCreated} same-domain edges.` : ""}${resetCount > 0 ? ` Reset ${resetCount} collapsed facts to 0.8.` : ""}${expertiseUpdated > 0 ? ` Recalculated expertise for ${expertiseUpdated} domains.` : ""}`,
		};
	});

// =============================================================================
// LIST DOMAINS
// =============================================================================

export // =============================================================================
// LIST DOMAINS
// =============================================================================

const listDomainsProcedure = authed.listDomains
	.use(AUTHZ.tedisRead)
	.handler(async ({ context }) => {
		const orgId = requireOrgId(context);
		const domains = await listDomains(context.db, orgId);
		return {
			domains,
		};
	});

// =============================================================================
// STATS
// =============================================================================

export // =============================================================================
// STATS
// =============================================================================

const stats = authed.stats.use(AUTHZ.tedisRead).handler(async ({ context }) => {
	const orgId = requireOrgId(context);
	return getMemoryGraphStats(context.db, orgId);
});

// =============================================================================
// ASSEMBLE CONTEXT
// =============================================================================

// NOTE: The Home kernel does NOT call this handler on the per-turn path.
// It uses the bounded relevance blend in kernel/context-assembly.ts
// (assembleHomeContext: one org-scoped D1 search, fail-soft,
// ahead of the static getTopPlatformFacts top-N). Explicit graph assembly
// rechecks the D1-owned projection and GDS freshness on every request; when
// admission fails it degrades to D1 without graph-derived boosts.

export const assemble = authed.assemble
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const graphClient = await getContextAssemblyGraphClient(context);
		return assembleContext(
			context.db,
			{
				query: input.query,
				orgId,
				tediId: input.tediId,
				maxTokens: input.maxTokens,
				domains: input.domains,
				factTypes: input.factTypes,
			},
			graphClient,
		);
	});

// =============================================================================
// EXPERTISE
// =============================================================================

export // =============================================================================
// EXPERTISE
// =============================================================================

const expertise = authed.expertise
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		let tediId = input.tediId ?? context.tediId;

		// Auto-resolve: if no tediId from input or context, find the org's first tedi
		if (!tediId) {
			const { getTedisByOrganization } =
				await import("@tedix/db/queries/tedis");
			const orgTedis = await getTedisByOrganization(context.db, orgId);
			if (orgTedis.length > 0) {
				tediId = orgTedis[0]!.id;
			}
		}
		if (!tediId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required — provide it explicitly or authenticate as a tedi",
			);
		// `getExpertise` filters on tediId ALONE, so the caller's org must be
		// checked against the tedi here or a `tedis:read` principal reads any
		// org's expertise by passing its tedi id. Auto-resolved and
		// context-derived ids are already in-org; an explicit one is not.
		if (input.tediId) {
			const tedi = await getTediById(context.db, input.tediId);
			if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
			if (tedi.organizationId !== orgId) {
				throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
			}
		}
		let domainId: string | undefined;
		if (input.domain) {
			const d = await getOrCreateDomain(context.db, orgId, input.domain);
			domainId = d.id;
		}
		const results = await getExpertise(context.db, tediId, domainId);
		return {
			expertise: results,
		};
	});

// =============================================================================
// PROMOTE
// =============================================================================
