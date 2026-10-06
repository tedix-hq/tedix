import {
	ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED,
	type GraphBenchmarkEdge,
	type GraphBenchmarkPath,
} from "@tedix/db/schema/graph-retrieval-benchmarks";
import type { TraversalResult } from "../integrations/graph-db/types";

export const GRAPH_RETRIEVAL_HARNESS_MODE =
	"retrieval_only_anchor_vs_neo4j_v1" as const;
export const GRAPH_RETRIEVAL_GRADUATION_MODE = "retrieval_only" as const;
export const GRAPH_RETRIEVAL_SEED = ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED;
export const GRAPH_RETRIEVAL_MAX_DEPTH = 3;
export const GRAPH_RETRIEVAL_MAX_NODES_PER_ANCHOR = 100;

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

function normalizedJson(value: unknown): JsonValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Benchmark checksums require finite numbers");
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizedJson);
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.filter((key) => record[key] !== undefined)
				.map((key) => [key, normalizedJson(record[key])]),
		);
	}
	throw new Error(`Unsupported benchmark checksum value: ${typeof value}`);
}

/** Stable, key-sorted JSON used only for server-owned checksums. */
export function stableBenchmarkJson(value: unknown): string {
	return JSON.stringify(normalizedJson(value));
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function benchmarkChecksum(value: unknown): Promise<string> {
	const encoded = new TextEncoder().encode(stableBenchmarkJson(value));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return bytesToHex(new Uint8Array(digest));
}

/**
 * A deterministic RFC-4122-shaped identifier for server-generated harness
 * observations. This is deliberately not advertised as UUIDv5: it uses
 * SHA-256, then sets the version/variant bits solely to satisfy UUID storage
 * and contract shape.
 */
export async function deterministicBenchmarkUuid(
	value: unknown,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(stableBenchmarkJson(value)),
		),
	).slice(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytesToHex(digest);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function edgeKey(edge: GraphBenchmarkEdge): string {
	return `${edge.sourceFactId}\u001f${edge.relationType}\u001f${edge.targetFactId}`;
}

function pathKey(path: GraphBenchmarkPath): string {
	return `${path.factIds.join("\u001e")}::${path.edges
		.map(edgeKey)
		.join("\u001e")}`;
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function mergeTraversalEdges(
	traversals: ReadonlyArray<TraversalResult>,
): GraphBenchmarkEdge[] {
	const edges = new Map<string, GraphBenchmarkEdge>();
	for (const traversal of traversals) {
		for (const edge of traversal.edges) {
			const benchmarkEdge = {
				sourceFactId: edge.sourceFactId,
				targetFactId: edge.targetFactId,
				relationType: edge.relationType,
			};
			edges.set(edgeKey(benchmarkEdge), benchmarkEdge);
		}
	}
	return [...edges.values()].sort((left, right) =>
		edgeKey(left).localeCompare(edgeKey(right)),
	);
}

type PathStep = {
	factIds: string[];
	edges: GraphBenchmarkEdge[];
};

function shortestPath(
	startFactId: string,
	targetFactId: string,
	edges: GraphBenchmarkEdge[],
	maxDepth: number,
): GraphBenchmarkPath | null {
	if (startFactId === targetFactId) {
		return { factIds: [startFactId], edges: [] };
	}
	const adjacency = new Map<
		string,
		Array<{ nextFactId: string; edge: GraphBenchmarkEdge }>
	>();
	for (const edge of edges) {
		const outgoing = adjacency.get(edge.sourceFactId) ?? [];
		outgoing.push({ nextFactId: edge.targetFactId, edge });
		adjacency.set(edge.sourceFactId, outgoing);
		const incoming = adjacency.get(edge.targetFactId) ?? [];
		incoming.push({ nextFactId: edge.sourceFactId, edge });
		adjacency.set(edge.targetFactId, incoming);
	}
	for (const neighbors of adjacency.values()) {
		neighbors.sort((left, right) => {
			const byFact = left.nextFactId.localeCompare(right.nextFactId);
			return byFact !== 0
				? byFact
				: edgeKey(left.edge).localeCompare(edgeKey(right.edge));
		});
	}

	const queue: PathStep[] = [{ factIds: [startFactId], edges: [] }];
	const bestDepth = new Map<string, number>([[startFactId, 0]]);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		const last = current.factIds.at(-1);
		if (!last || current.edges.length >= maxDepth) continue;
		for (const neighbor of adjacency.get(last) ?? []) {
			const depth = current.edges.length + 1;
			if (
				(bestDepth.get(neighbor.nextFactId) ?? Number.POSITIVE_INFINITY) < depth
			) {
				continue;
			}
			const next: PathStep = {
				factIds: [...current.factIds, neighbor.nextFactId],
				edges: [...current.edges, neighbor.edge],
			};
			if (neighbor.nextFactId === targetFactId) return next;
			bestDepth.set(neighbor.nextFactId, depth);
			queue.push(next);
		}
	}
	return null;
}

export type RetrievalOnlyObservation = {
	retrievedFactIds: string[];
	returnedEdges: GraphBenchmarkEdge[];
	returnedPaths: GraphBenchmarkPath[];
};

/** Fixed baseline: only the suite-authored anchors, with no inferred edges. */
export function buildAnchorOnlyObservation(
	anchorFactIds: string[],
): RetrievalOnlyObservation {
	return {
		retrievedFactIds: sortedUnique(anchorFactIds),
		returnedEdges: [],
		returnedPaths: [],
	};
}

/**
 * Deterministically converts bounded Neo4j traversals into an observation.
 * It does not claim answer generation, citation quality, or semantic relevance.
 * D1 still validates every returned node, relationship, and path afterwards.
 */
export function buildProjectedGraphObservation(input: {
	anchorFactIds: string[];
	expectedFactIds: string[];
	traversals: ReadonlyArray<TraversalResult>;
	maxDepth: number;
}): RetrievalOnlyObservation {
	const returnedEdges = mergeTraversalEdges(input.traversals);
	const retrievedFactIds = sortedUnique([
		...input.anchorFactIds,
		...input.traversals.flatMap((traversal) => [...traversal.facts.keys()]),
	]);
	const returnedPaths = new Map<string, GraphBenchmarkPath>();
	for (const anchorFactId of sortedUnique(input.anchorFactIds)) {
		for (const targetFactId of sortedUnique(input.expectedFactIds)) {
			const path = shortestPath(
				anchorFactId,
				targetFactId,
				returnedEdges,
				input.maxDepth,
			);
			if (path && path.factIds.length > 1) {
				returnedPaths.set(pathKey(path), path);
			}
		}
	}
	return {
		retrievedFactIds,
		returnedEdges,
		returnedPaths: [...returnedPaths.values()].sort((left, right) =>
			pathKey(left).localeCompare(pathKey(right)),
		),
	};
}
