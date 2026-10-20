/**
 * Pure builder for the System map app: how an organization is wired.
 *
 * The graph is compiled from queries the OS already makes (tedis, skills,
 * connections, workspaces), and `validateSystemMap` proves every edge lands on
 * a real node, so the map cannot drift from the registries. The approach is
 * borrowed from FounderOS's blueprint validation (MIT).
 */

export type SystemMapNodeKind = "tedi" | "skill" | "connection" | "workspace";
export type SystemMapEdgeKind = "uses" | "needs" | "owns";

export interface SystemMapTediInput {
	id: string;
	name: string;
	displayName?: string | null;
	ownerUserId?: string | null;
	/** Skill ids or slugs the tedi has installed. */
	installedSkills?: string[] | null;
}
export interface SystemMapSkillInput {
	id: string;
	title: string;
	slug?: string | null;
	/** Owning tedi, when the skill belongs to one. */
	tediId?: string | null;
	/** App the skill works through; matched against connection references. */
	appId?: string | null;
}
export interface SystemMapConnectionInput {
	/** Stable key, e.g. the provider app id or the connection instance id. */
	id: string;
	name: string;
	accountState: "present" | "missing" | "expired" | "restricted" | "unknown";
	/** Apps that reference this connection. */
	referenceAppIds: string[];
}
export interface SystemMapWorkspaceInput {
	id: string;
	name: string;
	visibility: "org" | "private";
	ownerUserId?: string | null;
}

export interface SystemMapSources {
	tedis: SystemMapTediInput[];
	skills: SystemMapSkillInput[];
	connections: SystemMapConnectionInput[];
	workspaces: SystemMapWorkspaceInput[];
}

export interface SystemMapNode {
	/** `${kind}:${sourceId}` */
	id: string;
	kind: SystemMapNodeKind;
	label: string;
	/** Connection credential state; absent for other kinds. */
	state?: SystemMapConnectionInput["accountState"];
	/** True when having no edge is normal (a shared workspace). */
	standalone?: boolean;
}
export interface SystemMapEdge {
	from: string;
	to: string;
	kind: SystemMapEdgeKind;
}
export interface SystemMap {
	nodes: SystemMapNode[];
	edges: SystemMapEdge[];
}

export type SystemMapFinding =
	| {
			kind: "dangling_edge";
			edge: SystemMapEdge;
			/** Which end of the edge does not exist. */
			missing: "from" | "to";
			/** The id the edge points at, without the kind prefix. */
			missingRef: string;
			/** The end that does exist; null when neither end does. */
			present: SystemMapNode | null;
	  }
	| { kind: "orphan_node"; node: SystemMapNode };

export const nodeId = (kind: SystemMapNodeKind, sourceId: string) =>
	`${kind}:${sourceId}`;

export function buildSystemMap(sources: SystemMapSources): SystemMap {
	const nodes: SystemMapNode[] = [];
	const edges: SystemMapEdge[] = [];
	const seen = new Set<string>();
	const addNode = (node: SystemMapNode) => {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		nodes.push(node);
	};
	const addEdge = (edge: SystemMapEdge) => {
		if (
			!edges.some(
				(e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
			)
		)
			edges.push(edge);
	};

	for (const t of sources.tedis)
		addNode({
			id: nodeId("tedi", t.id),
			kind: "tedi",
			label: t.displayName?.trim() || t.name,
		});
	for (const s of sources.skills)
		addNode({ id: nodeId("skill", s.id), kind: "skill", label: s.title });
	for (const c of sources.connections)
		addNode({
			id: nodeId("connection", c.id),
			kind: "connection",
			label: c.name,
			state: c.accountState,
		});
	for (const w of sources.workspaces)
		addNode({
			id: nodeId("workspace", w.id),
			kind: "workspace",
			label: w.name,
			standalone: w.visibility === "org",
		});

	const skillByRef = new Map<string, SystemMapSkillInput>();
	for (const s of sources.skills) {
		skillByRef.set(s.id, s);
		if (s.slug) skillByRef.set(s.slug, s);
	}

	for (const s of sources.skills)
		if (s.tediId)
			addEdge({
				from: nodeId("tedi", s.tediId),
				to: nodeId("skill", s.id),
				kind: "uses",
			});
	for (const t of sources.tedis)
		for (const ref of t.installedSkills ?? []) {
			const skill = skillByRef.get(ref);
			addEdge({
				from: nodeId("tedi", t.id),
				to: nodeId("skill", skill?.id ?? ref),
				kind: "uses",
			});
		}

	for (const s of sources.skills) {
		if (!s.appId) continue;
		for (const c of sources.connections)
			if (c.referenceAppIds.includes(s.appId))
				addEdge({
					from: nodeId("skill", s.id),
					to: nodeId("connection", c.id),
					kind: "needs",
				});
	}

	for (const w of sources.workspaces) {
		if (w.visibility !== "private" || !w.ownerUserId) continue;
		for (const t of sources.tedis)
			if (t.ownerUserId === w.ownerUserId)
				addEdge({
					from: nodeId("tedi", t.id),
					to: nodeId("workspace", w.id),
					kind: "owns",
				});
	}

	return { nodes, edges };
}

/** Every edge must land on real nodes, and every node should be reachable. */
export function validateSystemMap(map: SystemMap): SystemMapFinding[] {
	const byId = new Map(map.nodes.map((n) => [n.id, n]));
	const findings: SystemMapFinding[] = [];
	const linked = new Set<string>();
	for (const edge of map.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (from && to) {
			linked.add(edge.from);
			linked.add(edge.to);
		} else if (from || to) {
			const present = (from ?? to)!;
			linked.add(present.id);
			const missing = from ? "to" : "from";
			const missingId = from ? edge.to : edge.from;
			findings.push({
				kind: "dangling_edge",
				edge,
				missing,
				missingRef: missingId.slice(missingId.indexOf(":") + 1),
				present,
			});
		} else {
			// Neither end exists: report against the target id.
			findings.push({
				kind: "dangling_edge",
				edge,
				missing: "to",
				missingRef: edge.to.slice(edge.to.indexOf(":") + 1),
				present: null,
			});
		}
	}
	for (const node of map.nodes)
		if (!linked.has(node.id) && !node.standalone)
			findings.push({ kind: "orphan_node", node });
	return findings;
}
