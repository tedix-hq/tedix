import { Graph } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatCount, humanize, sentenceCase } from "@/lib/format";
import { errorMessage, isAuthorizationError } from "@/lib/orpc-error";
import {
	tediKnowledgeMapQueryOptions,
	tediRationaleQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Read bounds (each is the endpoint's own declared cap, not a shared one)
// ---------------------------------------------------------------------------

/** `graph.visualization` caps `maxNodes` at 500 and `depth` at 5. */
export const GRAPH_MAX_NODES = 60;
export const GRAPH_DEPTH = 2;

/**
 * `rationaleRecords.list` inherits the SHARED `PaginationSchema` cap of 100 —
 * unrelated to the 200/500 windows the runtime-event reads use. Never share a
 * limit constant across the two families.
 */
export const RATIONALE_LIMIT = 25;

// Map geometry (SVG user units).
const NODE_R = 6;
const RING_GAP = 104;
const INNER_RING_R = 52;
const PAD = 76;
/** Arc each node needs so a crowded ring stays readable rather than a smear. */
const NODE_ARC = 24;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type KnowledgeNodeType =
	| "fact"
	| "decision"
	| "domain"
	| "tedi"
	| "skill"
	| "knowledge_entry";

export interface KnowledgeNodeInput {
	id: string;
	label: string;
	type: KnowledgeNodeType;
}

export interface KnowledgeEdgeInput {
	source: string;
	target: string;
	type: string;
}

/**
 * Which concentric ring a node sits on.
 *
 * The knowledge map is read outward from what ANCHORS memory (the tedi and its
 * domains), through what has been consolidated (skills, knowledge entries), to
 * the raw evidence (facts, decisions). A flat force layout would hide exactly
 * that hierarchy, which is the one thing the picture is for.
 */
export const KNOWLEDGE_RING: Record<KnowledgeNodeType, number> = {
	tedi: 0,
	domain: 0,
	skill: 1,
	knowledge_entry: 1,
	fact: 2,
	decision: 2,
};

export interface KnowledgeLayoutNode {
	id: string;
	label: string;
	type: KnowledgeNodeType;
	ring: number;
	degree: number;
	x: number;
	y: number;
}

export interface KnowledgeLayoutEdge {
	id: string;
	from: string;
	to: string;
	type: string;
	path: string;
}

export interface KnowledgeLayout {
	nodes: KnowledgeLayoutNode[];
	edges: KnowledgeLayoutEdge[];
	size: number;
	/** Edges whose endpoints are not in the returned node set. */
	unresolvedEdgeCount: number;
}

/** SVG has no text overflow; a label is clipped in data, not in CSS. */
export function truncateLabel(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/**
 * Lay the knowledge map out as concentric rings, drawn inline.
 *
 * No graph library: the layout is pure trigonometry and the render is plain
 * SVG, so the map costs the initial page load nothing beyond this file. Node
 * order within a ring is (degree desc, id) so the same graph always draws the
 * same way regardless of the order the read returned.
 */
export function layoutKnowledgeGraph(
	nodes: readonly KnowledgeNodeInput[],
	edges: readonly KnowledgeEdgeInput[],
): KnowledgeLayout {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const resolved = edges.filter(
		(edge) =>
			edge.source !== edge.target &&
			byId.has(edge.source) &&
			byId.has(edge.target),
	);
	const unresolvedEdgeCount = edges.length - resolved.length;

	const degree = new Map<string, number>();
	for (const edge of resolved) {
		for (const id of [edge.source, edge.target]) {
			degree.set(id, (degree.get(id) ?? 0) + 1);
		}
	}

	const rings = new Map<number, KnowledgeNodeInput[]>();
	for (const node of nodes) {
		const ring = KNOWLEDGE_RING[node.type] ?? 2;
		const bucket = rings.get(ring);
		if (bucket) bucket.push(node);
		else rings.set(ring, [node]);
	}

	// Compact ring VALUES to dense indices: a graph with no domains must not
	// leave an empty inner ring and push everything to the rim.
	const ringIndex = new Map(
		[...rings.keys()].sort((a, b) => a - b).map((ring, index) => [ring, index]),
	);

	let maxRadius = 0;
	// Rings must grow outward monotonically even after the crowding push below,
	// or a densely populated inner ring would swallow the one outside it.
	let previousRadius = 0;
	const laidOut: KnowledgeLayoutNode[] = [];
	for (const [ring, bucket] of [...rings.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		const index = ringIndex.get(ring) ?? 0;
		const count = bucket.length;
		// A ring must be wide enough to seat its nodes: `maxNodes` is 60, and at
		// a fixed radius that many facts render as one unreadable smear.
		const crowded = (count * NODE_ARC) / (Math.PI * 2);
		const radius =
			index === 0 && count === 1
				? 0
				: Math.max(
						INNER_RING_R + index * RING_GAP,
						crowded,
						index === 0 ? 0 : previousRadius + RING_GAP / 2,
					);
		previousRadius = radius;
		maxRadius = Math.max(maxRadius, radius);
		bucket.sort(
			(a, b) =>
				(degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
				a.id.localeCompare(b.id),
		);
		// Every ring starting at the same angle stacks small rings into a single
		// vertical line — two domains and two skills drew as one column, not as
		// rings. Each ring is rotated by half a slot so they interleave.
		const slot = (Math.PI * 2) / Math.max(1, count);
		bucket.forEach((node, position) => {
			const angle =
				count === 1
					? -Math.PI / 2
					: -Math.PI / 2 + position * slot + (index * slot) / 2;
			laidOut.push({
				id: node.id,
				label: node.label,
				type: node.type,
				ring: index,
				degree: degree.get(node.id) ?? 0,
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
			});
		});
	}

	const size = Math.max(2 * (maxRadius + PAD), 2 * PAD);
	const center = size / 2;
	for (const node of laidOut) {
		node.x += center;
		node.y += center;
	}

	const positioned = new Map(laidOut.map((node) => [node.id, node]));
	const layoutEdges: KnowledgeLayoutEdge[] = [];
	for (const edge of resolved) {
		const from = positioned.get(edge.source);
		const to = positioned.get(edge.target);
		if (!from || !to) continue;
		layoutEdges.push({
			id: `${edge.source}->${edge.target}:${edge.type}`,
			from: edge.source,
			to: edge.target,
			type: edge.type,
			path: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
		});
	}
	// Stable keys: the read promises no edge order, and reshuffling keys between
	// two identical graphs churns the DOM for nothing.
	layoutEdges.sort((a, b) => a.id.localeCompare(b.id));

	return {
		nodes: laidOut,
		edges: layoutEdges,
		size: laidOut.length === 0 ? 0 : size,
		unresolvedEdgeCount,
	};
}

export const NODE_TYPE_CLASSES: Record<KnowledgeNodeType, string> = {
	tedi: "text-kumo-strong",
	domain: "text-kumo-info",
	skill: "text-kumo-success",
	knowledge_entry: "text-kumo-success",
	fact: "text-kumo-subtle",
	decision: "text-kumo-warning",
};

/**
 * The projection caveat carried by the read that produced these nodes.
 *
 * `meta` comes back WITH the visualization, so it describes the exact snapshot
 * drawn — a separate health read could describe a different moment. Null means
 * the map is current and needs no caveat.
 */
export function graphFreshnessNote(
	meta:
		| {
				graphConfigured: boolean;
				graphHealthy: boolean;
				projectionState: "disabled" | "catching_up" | "ready" | "degraded";
				projectionReady: boolean;
				projectionReason: string | null;
				degraded: boolean;
				source: "neo4j" | "none";
		  }
		| null
		| undefined,
): string | null {
	if (!meta) return null;
	if (!meta.graphConfigured || meta.source === "none") {
		return "No graph projection is configured, so this map is empty by configuration rather than because nothing was learned.";
	}
	if (meta.projectionState === "disabled") {
		return "The graph projection is disabled; this map is not a current view of memory.";
	}
	if (meta.projectionState === "catching_up" || !meta.projectionReady) {
		return `The graph projection is still catching up${
			meta.projectionReason ? ` (${meta.projectionReason})` : ""
		}, so recent facts may be missing from this map.`;
	}
	if (
		meta.projectionState === "degraded" ||
		meta.degraded ||
		!meta.graphHealthy
	) {
		return `The graph projection is degraded${
			meta.projectionReason ? ` (${meta.projectionReason})` : ""
		}; treat this map as incomplete.`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

export function KnowledgeMap({ layout }: { layout: KnowledgeLayout }) {
	if (layout.nodes.length === 0) return null;
	return (
		<Surface className="overflow-x-auto p-1">
			<svg
				role="img"
				aria-label={`Knowledge map: ${layout.nodes.length} nodes, ${layout.edges.length} relationships`}
				viewBox={`0 0 ${layout.size} ${layout.size}`}
				width={layout.size}
				height={layout.size}
				className="max-w-none"
			>
				<title>Tedi knowledge map</title>
				<g className="text-kumo-subtle">
					{layout.edges.map((edge) => (
						<path
							key={edge.id}
							d={edge.path}
							data-relation={edge.type}
							fill="none"
							stroke="currentColor"
							strokeOpacity={0.25}
							strokeWidth={1}
						/>
					))}
				</g>
				{layout.nodes.map((node) => (
					<g
						key={node.id}
						className={NODE_TYPE_CLASSES[node.type]}
						data-node-type={node.type}
						data-ring={node.ring}
					>
						<title>{`${node.label} · ${humanize(node.type)}`}</title>
						<circle
							cx={node.x}
							cy={node.y}
							r={node.ring === 0 ? NODE_R + 2 : NODE_R}
							fill="currentColor"
							fillOpacity={0.22}
							stroke="currentColor"
							strokeOpacity={0.7}
						/>
						{node.ring <= 1 && (
							<text
								x={node.x}
								y={node.y - NODE_R - 5}
								fontSize={10}
								textAnchor="middle"
								fill="currentColor"
							>
								{truncateLabel(node.label, 22)}
							</text>
						)}
					</g>
				))}
			</svg>
		</Surface>
	);
}

export function KnowledgeMapEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Graph size={20} />
				</EmptyMedia>
				<EmptyTitle>Nothing to map yet</EmptyTitle>
				<EmptyDescription>
					The knowledge map draws this tedi&apos;s domains, consolidated
					knowledge, and the facts beneath them. It fills in as the tedi
					observes, learns, and links what it knows.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/**
 * Memory exploration for one tedi: the knowledge map, and the decision journal
 * with its linked execution evidence.
 */
export function MemoryExplorer({ tediId }: { tediId: string }) {
	const graph = useQuery({
		...tediKnowledgeMapQueryOptions(tediId, GRAPH_DEPTH, GRAPH_MAX_NODES),
		staleTime: 60_000,
	});

	// Distinct from Brain's org-wide rationale read: same procedure, different
	// scope and page size. The generated key encodes the whole input, so the
	// tedi-scoped read and the org-wide one stay separate cache entries by
	// construction rather than by a hand-picked `"tedi"` key segment.
	const rationale = useQuery({
		...tediRationaleQueryOptions(tediId, RATIONALE_LIMIT),
		staleTime: 60_000,
	});

	const layout = useMemo(
		() =>
			layoutKnowledgeGraph(graph.data?.nodes ?? [], graph.data?.edges ?? []),
		[graph.data],
	);

	const freshness = graphFreshnessNote(graph.data?.meta);
	const graphRefused = isAuthorizationError(graph.error);
	const rationaleRefused = isAuthorizationError(rationale.error);
	const records = rationale.data?.data ?? [];
	const nodeCapReached = (graph.data?.nodes.length ?? 0) >= GRAPH_MAX_NODES;

	return (
		<>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Knowledge map</SectionTitle>
						<SectionDescription>
							A bounded view of connected concepts in this worker's memory.
						</SectionDescription>
					</SectionHeading>
					{graph.data ? (
						<Badge variant="secondary">{graph.data.nodes.length}</Badge>
					) : null}
				</SectionHeader>
				{graph.isPending && <ListSkeleton rows={1} rowClassName="h-48" />}
				{graph.isError && (
					<Alert variant={graphRefused ? "warning" : "destructive"}>
						<AlertTitle>
							{graphRefused
								? "The knowledge map is not readable with your access"
								: "The knowledge map is unavailable"}
						</AlertTitle>
						<AlertDescription>
							{graphRefused
								? "The graph read was refused for this principal. An empty map is not shown in its place."
								: errorMessage(graph.error)}
						</AlertDescription>
					</Alert>
				)}
				{graph.data && layout.nodes.length === 0 && <KnowledgeMapEmpty />}
				{layout.nodes.length > 0 && (
					<>
						<KnowledgeMap layout={layout} />
						<Text as="p" role="label" tone="secondary" className="m-0">
							{formatCount(layout.nodes.length)} nodes ·{" "}
							{formatCount(layout.edges.length)} relationships · depth{" "}
							{GRAPH_DEPTH}.
							{nodeCapReached
								? ` The read hit its ${formatCount(GRAPH_MAX_NODES)}-node cap, so this is a subgraph, not the whole memory.`
								: ""}
							{layout.unresolvedEdgeCount > 0
								? ` ${formatCount(layout.unresolvedEdgeCount)} relationships point outside the drawn subgraph.`
								: ""}
						</Text>
					</>
				)}
				{freshness && (
					<Text as="p" role="label" tone="warning" className="m-0">
						{freshness}
					</Text>
				)}
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Decision journal</SectionTitle>
						<SectionDescription>
							Recorded rationale, outcomes, and linked execution evidence.
						</SectionDescription>
					</SectionHeading>
					{rationale.data ? (
						<Badge variant="secondary">{rationale.data.pagination.total}</Badge>
					) : null}
				</SectionHeader>
				{rationale.isPending && <ListSkeleton rows={2} />}
				{rationale.isError && (
					<Alert variant={rationaleRefused ? "warning" : "destructive"}>
						<AlertTitle>
							{rationaleRefused
								? "Decisions are not readable with your access"
								: "Decisions are unavailable"}
						</AlertTitle>
						<AlertDescription>
							{rationaleRefused
								? "The rationale read was refused for this principal."
								: errorMessage(rationale.error)}
						</AlertDescription>
					</Alert>
				)}
				{rationale.data && records.length === 0 && (
					<Text as="p" role="body" tone="secondary" className="m-0">
						This tedi has recorded no decisions yet.
					</Text>
				)}
				{records.length > 0 && (
					<>
						<ul className="m-0 grid list-none gap-1 p-0">
							{records.map((record) => (
								<Surface
									as="li"
									key={record.id}
									className="grid min-w-0 gap-1 overflow-hidden border-kumo-hairline px-3 py-2.5"
								>
									<span className="flex flex-wrap items-center gap-1.5">
										<Badge
											variant={
												record.outcomeStatus === "success"
													? "success"
													: record.outcomeStatus === "failure"
														? "error"
														: record.outcomeStatus === "pending"
															? "info"
															: "warning"
											}
										>
											{sentenceCase(record.outcomeStatus)}
										</Badge>
										<Text as="span" role="label" tone="secondary">
											{humanize(record.category)} ·{" "}
											{Math.round(record.confidence * 100)}% confident
										</Text>
									</span>
									<Text
										as="span"
										role="body"
										tone="strong"
										weight="medium"
										className="truncate"
									>
										{record.action}
									</Text>
									<Text as="span" role="label" tone="secondary">
										{record.rationale}
									</Text>
									<Text as="span" role="label" tone="secondary">
										decided{" "}
										<time
											dateTime={record.createdAt}
											title={absoluteTime(record.createdAt)}
										>
											{relativeTime(record.createdAt)}
										</time>
										{record.runId ? ` · run ${record.runId.slice(0, 8)}` : ""}
									</Text>
								</Surface>
							))}
						</ul>
						{rationale.data?.pagination.hasMore && (
							<Text as="p" role="label" tone="secondary" className="m-0">
								Showing the latest {formatCount(records.length)} of{" "}
								{formatCount(rationale.data.pagination.total)} decisions.
							</Text>
						)}
					</>
				)}
			</PageSection>
		</>
	);
}
