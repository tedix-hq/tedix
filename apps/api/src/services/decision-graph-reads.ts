/**
 * Graph-backed decision graph reads with D1 fallback.
 *
 * D1 (`@tedix/db/queries/decision-graph`) stays canonical and always answers.
 * When the graph database is configured, two bounded Cypher reads add what D1
 * cannot answer cheaply: how many items a card blocks directly or indirectly,
 * and the duplicate community around it. A missing config, an error or a slow
 * answer leaves the D1 result unchanged.
 */

import type { DecisionContext } from "@tedix/api-contract/schemas/decision-graph";
import {
	getGraphDbSecrets,
	runCypherWithParams,
} from "../integrations/graph-db/client";
import { terminalWorkItemIds } from "@tedix/db/queries/decision-graph";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	blocksReachQuery,
	DECISION_GRAPH_MAX_REACH_PATHS,
	decisionNodeKey,
	duplicateCommunityQuery,
} from "../integrations/graph-db/queries/decision-graph";

/** Graph reads give up after this long; the Deck must never wait on them. */
export const DECISION_GRAPH_READ_TIMEOUT_MS = 1_500;
/** Cards per Cypher call. */
const CARDS_PER_READ = 100;

export type DecisionGraphCardSubject = {
	id: string;
	/** Canonical source Work, covering edge backfill lag. */
	workItemId?: string | null;
};

export type DecisionGraphReader = {
	blocksReach(
		orgId: string,
		cards: readonly DecisionGraphCardSubject[],
	): Promise<Map<string, number>>;
	duplicateCommunities(
		orgId: string,
		cardIds: readonly string[],
	): Promise<Map<string, string[]>>;
};

type RunCypher = (
	query: string,
	params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("decision graph read timed out")),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Which of these Work ids D1 records as completed or cancelled. */
export type TerminalWorkLookup = (
	orgId: string,
	ids: readonly string[],
) => Promise<Set<string>>;

const WORK_KEY_PREFIX = decisionNodeKey("work_item", "");

/**
 * Distinct walk endpoints, skipping every walk that passes through terminal
 * Work. Null when the graph capped the paths, so the caller keeps `reach`.
 */
function openReach(
	paths: unknown,
	terminal: ReadonlySet<string>,
): number | null {
	if (!Array.isArray(paths) || paths.length >= DECISION_GRAPH_MAX_REACH_PATHS)
		return null;
	const endpoints = new Set<string>();
	for (const path of paths) {
		if (!Array.isArray(path) || path.length < 2) continue;
		const keys = path.map(String);
		if (
			keys.some(
				(key) =>
					key.startsWith(WORK_KEY_PREFIX) &&
					terminal.has(key.slice(WORK_KEY_PREFIX.length)),
			)
		)
			continue;
		endpoints.add(keys[keys.length - 1]!);
	}
	return endpoints.size;
}

export function createDecisionGraphReaderFrom(
	run: RunCypher,
	timeoutMs = DECISION_GRAPH_READ_TIMEOUT_MS,
	terminalWork?: TerminalWorkLookup,
): DecisionGraphReader {
	return {
		async blocksReach(orgId, cards) {
			const reach = new Map<string, number>();
			for (let offset = 0; offset < cards.length; offset += CARDS_PER_READ) {
				const page = cards.slice(offset, offset + CARDS_PER_READ);
				const rows = await withTimeout(
					run(blocksReachQuery().query, {
						orgId,
						cards: page.map((card) => ({
							id: card.id,
							keys: [
								decisionNodeKey("deck_card", card.id),
								...(card.workItemId
									? [decisionNodeKey("work_item", card.workItemId)]
									: []),
							],
						})),
					}),
					timeoutMs,
				);
				const workIds = rows.flatMap((row) =>
					(Array.isArray(row.paths) ? row.paths.flat() : [])
						.map(String)
						.filter((key) => key.startsWith(WORK_KEY_PREFIX))
						.map((key) => key.slice(WORK_KEY_PREFIX.length)),
				);
				const terminal =
					terminalWork && workIds.length > 0
						? await terminalWork(orgId, workIds)
						: null;
				for (const row of rows) {
					const open = terminal ? openReach(row.paths, terminal) : null;
					reach.set(
						String(row.cardId),
						open ?? Math.max(0, Number(row.reach) || 0),
					);
				}
			}
			return reach;
		},
		async duplicateCommunities(orgId, cardIds) {
			const communities = new Map<string, string[]>();
			for (let offset = 0; offset < cardIds.length; offset += CARDS_PER_READ) {
				const rows = await withTimeout(
					run(duplicateCommunityQuery().query, {
						orgId,
						cardIds: cardIds.slice(offset, offset + CARDS_PER_READ),
					}),
					timeoutMs,
				);
				for (const row of rows) {
					const duplicates = Array.isArray(row.duplicates)
						? row.duplicates.map(String)
						: [];
					communities.set(String(row.cardId), duplicates);
				}
			}
			return communities;
		},
	};
}

/**
 * The graph-backed reader, or null when no graph database is configured.
 * With `db`, walks through Work that D1 records as completed or cancelled
 * do not count toward a card's reach.
 */
export function createDecisionGraphReader(
	env: CloudflareEnv | undefined,
	db?: DbQueryClient,
): DecisionGraphReader | null {
	if (!env || !getGraphDbSecrets(env)) return null;
	return createDecisionGraphReaderFrom(
		(query, params) => runCypherWithParams(env, query, params),
		DECISION_GRAPH_READ_TIMEOUT_MS,
		db ? (orgId, ids) => terminalWorkItemIds(db, orgId, ids) : undefined,
	);
}

/**
 * Add graph facts to D1 contexts in place: blocksReach and the union of D1
 * and graph duplicates. Any graph failure keeps the D1 contexts as they are.
 */
export async function enrichDecisionContexts(
	reader: DecisionGraphReader | null,
	orgId: string,
	cards: readonly DecisionGraphCardSubject[],
	contexts: Map<string, DecisionContext>,
): Promise<void> {
	if (!reader || cards.length === 0) return;
	const [reach, communities] = await Promise.allSettled([
		reader.blocksReach(orgId, cards),
		reader.duplicateCommunities(
			orgId,
			cards.map((card) => card.id),
		),
	]);
	if (reach.status === "rejected" || communities.status === "rejected") {
		console.warn("[decision-graph] graph read failed; using D1 only", {
			reach: reach.status,
			communities: communities.status,
		});
	}
	for (const card of cards) {
		const context = contexts.get(card.id);
		if (!context) continue;
		if (reach.status === "fulfilled" && reach.value.has(card.id)) {
			context.blocksReach = Math.max(
				context.blocksCount,
				reach.value.get(card.id) ?? 0,
			);
		}
		const community =
			communities.status === "fulfilled"
				? communities.value.get(card.id)
				: undefined;
		if (community?.length) {
			context.duplicates = [...new Set([...context.duplicates, ...community])]
				.filter((id) => id !== card.id)
				.sort();
		}
	}
}
