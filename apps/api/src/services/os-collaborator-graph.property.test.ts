import { describe, expect, it } from "vite-plus/test";
import {
	OS_WORKSPACE_OPERATION_ROLES,
	operationAllowed,
	operationsForRole,
	type OsCollaboratorRole,
} from "@tedix/api-contract/schemas/os-collaborators";
import {
	computeEffectiveRoles,
	diffRoles,
	type GraphChange,
	type GraphEdge,
	type GraphLink,
	type PermissionGraph,
	planKeptUserEdges,
	type RoleMap,
} from "./os-collaborator-graph";

/**
 * Property tests for the collaborator graph over many seeded random graphs.
 * The oracle below is an independent reachability computation: `build`
 * reaches only along build edges from build holders, any access reaches
 * along any live edge from any holder, and roots keep their root role.
 */

const ROLES: OsCollaboratorRole[] = ["use", "build"];
const RANK = { use: 1, build: 2 } as const;
const PEOPLE = ["owner", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
const CASES = 400;

function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(next: () => number, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)]!;
}

function randomGraph(next: () => number): PermissionGraph {
	const roots = new Map<string, OsCollaboratorRole>([["owner", "build"]]);
	if (next() < 0.3) roots.set(pick(next, PEOPLE.slice(1)), pick(next, ROLES));
	const links: GraphLink[] = Array.from(
		{ length: Math.floor(next() * 3) },
		(_, index) => ({
			id: `link-${index}`,
			creatorId: pick(next, PEOPLE),
			role: pick(next, ROLES),
			revoked: next() < 0.25,
		}),
	);
	const edges: GraphEdge[] = Array.from(
		{ length: Math.floor(next() * 12) },
		() =>
			links.length > 0 && next() < 0.3
				? {
						kind: "link",
						targetId: pick(next, PEOPLE),
						linkId: pick(next, links).id,
					}
				: {
						kind: "user",
						targetId: pick(next, PEOPLE),
						sharerId: pick(next, PEOPLE),
						role: pick(next, ROLES),
					},
	);
	return { roots, edges, links };
}

function randomChange(next: () => number, graph: PermissionGraph): GraphChange {
	const roll = next();
	if (roll < 0.33)
		return { removedUserId: pick(next, PEOPLE.slice(1)) } satisfies GraphChange;
	const userEdges = graph.edges.filter((edge) => edge.kind === "user");
	if (roll < 0.66 && userEdges.length > 0) {
		const edge = pick(next, userEdges);
		return {
			removedEdge: { targetId: edge.targetId, sharerId: edge.sharerId },
		};
	}
	if (graph.links.length > 0)
		return { revokedLinkId: pick(next, graph.links).id };
	return {};
}

/** The live (target, sharer, role) triples after a change, resolved independently. */
function liveGrants(graph: PermissionGraph, change: GraphChange) {
	return graph.edges.flatMap((edge) => {
		if (graph.roots.has(edge.targetId)) return [];
		if (edge.targetId === change.removedUserId) return [];
		let sharer: string;
		let role: OsCollaboratorRole;
		if (edge.kind === "user") {
			if (
				change.removedEdge?.targetId === edge.targetId &&
				change.removedEdge.sharerId === edge.sharerId
			)
				return [];
			sharer = edge.sharerId;
			role = edge.role;
		} else {
			const link = graph.links.find(
				(candidate) => candidate.id === edge.linkId,
			);
			if (!link || link.revoked || link.id === change.revokedLinkId) return [];
			sharer = link.creatorId;
			role = link.role;
		}
		if (sharer === change.removedUserId) return [];
		return [{ target: edge.targetId, sharer, role }];
	});
}

function oracle(graph: PermissionGraph, change: GraphChange = {}): RoleMap {
	const grants = liveGrants(graph, change);
	const closure = (seed: Iterable<string>, usable: typeof grants) => {
		const reached = new Set(seed);
		let grew = true;
		while (grew) {
			grew = false;
			for (const grant of usable)
				if (reached.has(grant.sharer) && !reached.has(grant.target)) {
					reached.add(grant.target);
					grew = true;
				}
		}
		return reached;
	};
	const builders = closure(
		[...graph.roots].filter(([, role]) => role === "build").map(([id]) => id),
		grants.filter((grant) => grant.role === "build"),
	);
	const anyone = closure(graph.roots.keys(), grants);
	const roles: RoleMap = new Map();
	for (const id of anyone) roles.set(id, builders.has(id) ? "build" : "use");
	for (const [id, role] of graph.roots) roles.set(id, role);
	return roles;
}

function sorted(map: RoleMap) {
	return [...map].sort(([a], [b]) => a.localeCompare(b));
}

function* cases(seed: number) {
	const next = random(seed);
	for (let i = 0; i < CASES; i += 1) {
		const graph = randomGraph(next);
		yield { graph, change: randomChange(next, graph), next };
	}
}

describe("collaborator graph properties", () => {
	it("matches an independent reachability oracle, before and after any change", () => {
		for (const { graph, change } of cases(1)) {
			expect(sorted(computeEffectiveRoles(graph))).toEqual(
				sorted(oracle(graph)),
			);
			expect(sorted(computeEffectiveRoles(graph, change))).toEqual(
				sorted(oracle(graph, change)),
			);
		}
	});

	it("never grants anyone more than an edge's role or its sharer's role", () => {
		for (const { graph, change } of cases(2)) {
			const roles = computeEffectiveRoles(graph, change);
			const grants = liveGrants(graph, change);
			for (const [id, role] of roles) {
				if (graph.roots.has(id)) {
					expect(role).toBe(graph.roots.get(id));
					continue;
				}
				const justified = grants.some(
					(grant) =>
						grant.target === id &&
						RANK[grant.role] >= RANK[role] &&
						RANK[roles.get(grant.sharer) ?? "use"] >= RANK[role] &&
						roles.has(grant.sharer),
				);
				expect(justified, `${id} at ${role}`).toBe(true);
			}
		}
	});

	it("only lowers or removes access on a revocation, never raises it", () => {
		for (const { graph, change } of cases(3)) {
			const before = computeEffectiveRoles(graph);
			const after = computeEffectiveRoles(graph, change);
			for (const [id, role] of after)
				expect(
					before.has(id) && RANK[before.get(id)!] >= RANK[role],
					`${id} rose to ${role} after ${JSON.stringify(change)}`,
				).toBe(true);
			if (change.removedUserId && !graph.roots.has(change.removedUserId))
				expect(after.has(change.removedUserId)).toBe(false);
			const lost = diffRoles(before, after).map((row) => row.userId);
			for (const id of before.keys())
				expect(lost.includes(id)).toBe(
					!after.has(id) || RANK[after.get(id)!] < RANK[before.get(id)!],
				);
		}
	});

	it("models a change exactly as recomputing from the edges that remain", () => {
		for (const { graph, change } of cases(4)) {
			const remaining: PermissionGraph = {
				roots: graph.roots,
				links: graph.links.map((link) => ({
					...link,
					revoked:
						link.revoked ||
						link.id === change.revokedLinkId ||
						link.creatorId === change.removedUserId,
				})),
				edges: graph.edges.filter(
					(edge) =>
						edge.targetId !== change.removedUserId &&
						!(
							edge.kind === "user" &&
							(edge.sharerId === change.removedUserId ||
								(edge.targetId === change.removedEdge?.targetId &&
									edge.sharerId === change.removedEdge.sharerId))
						),
				),
			};
			expect(sorted(computeEffectiveRoles(graph, change))).toEqual(
				sorted(computeEffectiveRoles(remaining)),
			);
		}
	});

	it("does not depend on edge order", () => {
		for (const { graph, next } of cases(5)) {
			const shuffled = [...graph.edges].sort(() => next() - 0.5);
			expect(
				sorted(computeEffectiveRoles({ ...graph, edges: shuffled })),
			).toEqual(sorted(computeEffectiveRoles(graph)));
		}
	});

	it("re-adds kept people at most at the caller's role and never to the caller", () => {
		for (const { graph, change, next } of cases(6)) {
			const before = computeEffectiveRoles(graph);
			const after = computeEffectiveRoles(graph, change);
			const caller = pick(next, PEOPLE);
			const callerRole = after.get(caller);
			if (!callerRole) continue;
			const affected = diffRoles(before, after);
			const keep = affected.filter(() => next() < 0.7).map((row) => row.userId);
			const planned = planKeptUserEdges({
				callerId: caller,
				callerRole,
				affected,
				keepUserIds: keep,
			});
			for (const edge of planned) {
				expect(edge.sharerId).toBe(caller);
				expect(edge.targetId).not.toBe(caller);
				expect(keep).toContain(edge.targetId);
				expect(RANK[edge.role]).toBeLessThanOrEqual(RANK[callerRole]);
				expect(RANK[edge.role]).toBeLessThanOrEqual(
					RANK[before.get(edge.targetId)!],
				);
			}
			// Applying the plan restores no one above what they had before.
			const restored = computeEffectiveRoles(
				{
					...graph,
					edges: [...graph.edges, ...planned],
				},
				change,
			);
			for (const [id, role] of restored)
				if (!graph.roots.has(id))
					expect(RANK[role]).toBeLessThanOrEqual(RANK[before.get(id) ?? "use"]);
		}
	});
});

describe("workspace operation allowlist", () => {
	it("gives use exactly the app allowlist and build everything", () => {
		expect(operationsForRole("use")).toEqual([
			"app.connect",
			"app.render",
			"metadata.read",
			"presence.read",
		]);
		expect(operationsForRole("build")).toEqual(
			Object.keys(OS_WORKSPACE_OPERATION_ROLES).sort(),
		);
	});

	it("denies every operation without a role and every unknown operation with one", () => {
		for (const operation of Object.keys(OS_WORKSPACE_OPERATION_ROLES)) {
			expect(operationAllowed(null, operation)).toBe(false);
			expect(operationAllowed(undefined, operation)).toBe(false);
			expect(operationAllowed("admin" as OsCollaboratorRole, operation)).toBe(
				false,
			);
			expect(
				operationAllowed("__proto__" as OsCollaboratorRole, operation),
			).toBe(false);
		}
		for (const operation of [
			"__proto__",
			"constructor",
			"toString",
			"hasOwnProperty",
			"",
			"app.*",
			"APP.RENDER",
			"sharing.write ",
		])
			for (const role of ROLES)
				expect(operationAllowed(role, operation), operation).toBe(false);
	});
});
