import type { DbClient } from "../../client";
import type { MemoryOwnerScope } from "@tedix/api-contract/schemas/memory-graph";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	authorizeMemoryOwner,
	memoryStoreName,
	type MemoryOwnerAccess,
} from "../../tenant-store/memory-owner";
import type { TenantScope } from "../../tenant-scope";
import type { TenantStore } from "../../tenant-store/store";
import {
	requireWorkspaceScope,
	routeTenantQuery,
} from "../../tenant-store/router";
import type { TenantStorePlane } from "../durable-sqlite/tenant-store";
import { auditMemoryGraph, type BrainAuditInput } from "../memory-audit";
import * as entities from "../memory-entities";
import * as facts from "./facts";
import * as recall from "./hybrid-recall";
import * as citations from "./fact-citations";
import * as links from "./auto-linking";
import { getOrCreateDomain } from "./domains";
import { getExpertise, recalculateExpertise } from "./expertise";
import { getMemoryHealthExtended } from "./health";
import { getMemoryGraphStats } from "./stats";
import { createCuriosityItem, listCuriosityQueue } from "./curiosity";
import {
	createOptimizationSignal,
	listOptimizationSignals,
} from "./optimization-signals";
import { selectMemoryStore } from "./tenant-store";

type Store = ReturnType<typeof selectMemoryStore>;
type ScopedInput<F extends (...args: never[]) => unknown> = Omit<
	Parameters<F>[1],
	keyof TenantScope
>;
type RecallInput = Omit<recall.RecallScope, keyof TenantScope> & {
	query: string;
};

// Scope always comes from the routing boundary, never from request payloads.
const operations = {
	expertise: (
		store: Store,
		scope: TenantScope,
		input: { tediId: string; domainId?: string },
	) => getExpertise(store.db, scope, input.tediId, input.domainId),
	recalculateExpertise: (
		store: Store,
		scope: TenantScope,
		input: { tediId: string; domainId: string },
	) => recalculateExpertise(store.db, scope, input.tediId, input.domainId),
	health: (store: Store, scope: TenantScope, _input: Record<string, never>) =>
		getMemoryHealthExtended(store.db, scope),
	stats: (store: Store, scope: TenantScope, _input: Record<string, never>) =>
		getMemoryGraphStats(store.db, scope),
	createCuriosity: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof createCuriosityItem>,
	) => createCuriosityItem(store.db, { ...input, ...scope }),
	curiosity: (
		store: Store,
		scope: TenantScope,
		input: NonNullable<Parameters<typeof listCuriosityQueue>[2]>,
	) => listCuriosityQueue(store.db, scope, input),
	createOptimizationSignal: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof createOptimizationSignal>,
	) => createOptimizationSignal(store.db, { ...input, ...scope }),
	optimizationSignals: (
		store: Store,
		scope: TenantScope,
		input: NonNullable<Parameters<typeof listOptimizationSignals>[2]>,
	) => listOptimizationSignals(store.db, scope, input),
	createFact: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof facts.createFact>,
	) => facts.createFact(store.db, { ...input, ...scope }),
	getFact: (store: Store, scope: TenantScope, input: { factId: string }) =>
		facts.getFactById(store.db, scope, input.factId),
	updateFact: (
		store: Store,
		scope: TenantScope,
		input: { factId: string; updates: Parameters<typeof facts.updateFact>[3] },
	) => facts.updateFact(store.db, scope, input.factId, input.updates),
	topicFacts: (store: Store, scope: TenantScope, input: { topicKey: string }) =>
		facts.findCurrentFactsByTopicKey(store.db, scope, input.topicKey),
	sourceFact: (
		store: Store,
		scope: TenantScope,
		input: { sourceHash: string },
	) => facts.findFactBySourceHash(store.db, scope, input.sourceHash),
	domain: (
		store: Store,
		scope: TenantScope,
		input: { name: string; description?: string },
	) => getOrCreateDomain(store.db, scope, input.name, input.description),
	lexicalRecall: (store: Store, scope: TenantScope, input: RecallInput) =>
		recall.lexicalRecall(store.db, { ...input, ...scope }, input.query),
	graphRecall: (store: Store, scope: TenantScope, input: RecallInput) =>
		recall.graphRecall(store.db, { ...input, ...scope }, input.query),
	temporalRecall: (store: Store, scope: TenantScope, input: RecallInput) =>
		recall.temporalRecall(store.db, { ...input, ...scope }, input.query),
	hydrateRecall: (
		store: Store,
		scope: TenantScope,
		input: Omit<recall.RecallScope, keyof TenantScope> & { factIds: string[] },
	) => recall.hydrateRecall(store.db, { ...input, ...scope }, input.factIds),
	recordRecallAccess: (
		store: Store,
		scope: TenantScope,
		input: { factIds: string[] },
	) => recall.recordRecallAccess(store.db, scope, input.factIds),
	createEntity: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.createMemoryEntity>,
	) => entities.createMemoryEntity(store.db, { ...input, ...scope }),
	getEntity: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.getMemoryEntity>,
	) => entities.getMemoryEntity(store.db, { ...input, ...scope }),
	recordMention: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.recordMemoryEntityMention>,
	) => entities.recordMemoryEntityMention(store.db, { ...input, ...scope }),
	proposeResolution: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.proposeMemoryEntityResolution>,
	) => entities.proposeMemoryEntityResolution(store.db, { ...input, ...scope }),
	proposeRollback: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.proposeMemoryEntityResolutionRollback>,
	) =>
		entities.proposeMemoryEntityResolutionRollback(store.db, {
			...input,
			...scope,
		}),
	reviewResolution: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.reviewMemoryEntityResolutionProposal>,
	) =>
		entities.reviewMemoryEntityResolutionProposal(store.db, {
			...input,
			...scope,
		}),
	mentionState: (
		store: Store,
		scope: TenantScope,
		input: ScopedInput<typeof entities.getMemoryEntityMentionState>,
	) => entities.getMemoryEntityMentionState(store.db, { ...input, ...scope }),
	autoLinkFacts: (
		store: Store,
		scope: TenantScope,
		input: Omit<links.AutoLinkScope, keyof TenantScope>,
	) => links.listAutoLinkFacts(store.db, { ...input, ...scope }),
	createAutoLink: (
		store: Store,
		scope: TenantScope,
		input: {
			selection: Omit<links.AutoLinkScope, keyof TenantScope>;
			edge: Parameters<typeof links.createAutoLinkEdge>[2];
		},
	) =>
		links.createAutoLinkEdge(
			store.db,
			{ ...input.selection, ...scope },
			input.edge,
		),
	citationDependents: (
		store: Store,
		scope: TenantScope,
		input: { factIds: string[] },
	) => citations.findCitationDependents(store.db, scope, input.factIds),
	audit: (
		store: Store,
		scope: TenantScope,
		input: { tediId: string; filters?: BrainAuditInput },
	) =>
		auditMemoryGraph(
			{ db: store.auditDb, ...scope, tediId: input.tediId },
			input.filters,
		),
};

export type MemoryOperation = keyof typeof operations;
export type MemoryQuery<K extends MemoryOperation = MemoryOperation> = {
	[P in K]: { operation: P; input: Parameters<(typeof operations)[P]>[2] };
}[K];
export type MemoryQueryResult<K extends MemoryOperation> = Awaited<
	ReturnType<(typeof operations)[K]>
>;

/** Dispatch only named memory queries; this boundary never accepts SQL or callbacks. */
export async function executeMemoryQuery<K extends MemoryOperation>(
	store: Store,
	scope: TenantScope,
	query: MemoryQuery<K>,
): Promise<MemoryQueryResult<K>> {
	if (!Object.hasOwn(operations, query.operation))
		throw new Error("Unknown memory operation");
	// The discriminated request couples each input to its handler. Indexing a
	// mapped union loses that relationship in TypeScript.
	const operation = operations[query.operation] as (
		store: Store,
		scope: TenantScope,
		input: MemoryQuery<K>["input"],
	) => ReturnType<(typeof operations)[K]>;
	return (await operation(store, scope, query.input)) as MemoryQueryResult<K>;
}

export type MemoryQueryConfig =
	| { plane: Extract<TenantStorePlane, "platform-d1">; db: DbClient }
	| {
			plane: Extract<TenantStorePlane, "do-local-sqlite">;
			namespace: DurableObjectNamespace<TenantStore>;
			env: unknown;
	  };

/**
 * Route an explicitly owned memory store after gateway authentication and
 * per-fact authorization. Organization access does not consult workspace IDs.
 * Shared D1 cannot enforce new workspace/personal partitions, so rejects them.
 */
export async function queryOwnedMemory<K extends MemoryOperation>(
	config: MemoryQueryConfig,
	requested: MemoryOwnerScope,
	access: MemoryOwnerAccess,
	query: MemoryQuery<K>,
): Promise<MemoryQueryResult<K>> {
	const owner = authorizeMemoryOwner(requested, access);
	if (config.plane === "platform-d1") {
		if (owner.kind !== "organization")
			throw new Error("Scoped memory requires an owner-partitioned store");
		return executeMemoryQuery(
			selectMemoryStore(config),
			{ organizationId: owner.organizationId },
			query,
		);
	}
	const store = durableObjectStubByName(
		config.namespace,
		config.env,
		memoryStoreName(owner),
	);
	return store.ownedMemory(owner, query as MemoryQuery) as Promise<
		MemoryQueryResult<K>
	>;
}

/** Call after authorizing the workspace; a missing tenant binding has no D1 fallback. */
export async function queryMemory<K extends MemoryOperation>(
	config: MemoryQueryConfig,
	scope: TenantScope,
	query: MemoryQuery<K>,
): Promise<MemoryQueryResult<K>> {
	const workspace = requireWorkspaceScope(scope);
	if (config.plane === "platform-d1")
		return executeMemoryQuery(selectMemoryStore(config), workspace, query);
	return routeTenantQuery(
		config.namespace,
		config.env,
		workspace,
		(store, bound) => store.memory(bound, query as MemoryQuery),
	) as MemoryQueryResult<K>;
}
