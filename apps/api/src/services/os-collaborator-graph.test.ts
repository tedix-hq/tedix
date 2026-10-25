import { describe, expect, it } from "vite-plus/test";
import {
	computeEffectiveRoles,
	diffRoles,
	type GraphEdge,
	type GraphLink,
	type PermissionGraph,
	planKeptUserEdges,
} from "./os-collaborator-graph";

const OWNER = "owner";

function graph(
	edges: GraphEdge[],
	links: GraphLink[] = [],
	roots: [string, "use" | "build"][] = [[OWNER, "build"]],
): PermissionGraph {
	return { roots: new Map(roots), edges, links };
}

function user(
	targetId: string,
	sharerId: string,
	role: "use" | "build" = "build",
): GraphEdge {
	return { kind: "user", targetId, sharerId, role };
}

function roles(g: PermissionGraph, change = {}) {
	return Object.fromEntries(computeEffectiveRoles(g, change));
}

describe("computeEffectiveRoles", () => {
	it("treats the owner as the implicit build root", () => {
		expect(roles(graph([]))).toEqual({ owner: "build" });
	});

	it("follows a chain and caps each hop at the sharer's role", () => {
		const g = graph([
			user("alice", OWNER, "build"),
			user("bob", "alice", "build"),
			user("carol", "bob", "use"),
			user("dave", "carol", "build"),
		]);
		expect(roles(g)).toEqual({
			owner: "build",
			alice: "build",
			bob: "build",
			carol: "use",
			// Carol can only pass on what she has.
			dave: "use",
		});
	});

	it("takes the max over a diamond", () => {
		const g = graph([
			user("alice", OWNER, "use"),
			user("bob", OWNER, "build"),
			user("carol", "alice", "build"),
			user("carol", "bob", "build"),
		]);
		expect(roles(g).carol).toBe("build");
		// Removing the build path downgrades rather than removes.
		expect(roles(g, { removedUserId: "bob" }).carol).toBe("use");
	});

	it("terminates on cycles and grants nothing to an unrooted cycle", () => {
		const rooted = graph([
			user("alice", OWNER),
			user("bob", "alice"),
			user("alice", "bob"),
		]);
		expect(roles(rooted)).toEqual({
			owner: "build",
			alice: "build",
			bob: "build",
		});
		const unrooted = graph([user("alice", "bob"), user("bob", "alice")]);
		expect(roles(unrooted)).toEqual({ owner: "build" });
		// Severing the root edge leaves the cycle with no access.
		expect(
			roles(rooted, { removedEdge: { targetId: "alice", sharerId: OWNER } }),
		).toEqual({ owner: "build" });
	});

	it("resolves link edges through the link's role and its creator", () => {
		const links: GraphLink[] = [
			{ id: "l1", creatorId: "alice", role: "build", revoked: false },
		];
		const g = graph(
			[
				user("alice", OWNER, "use"),
				{ kind: "link", targetId: "zoe", linkId: "l1" },
			],
			links,
		);
		// The link says build, but its creator only has use.
		expect(roles(g).zoe).toBe("use");
		expect(roles(g, { revokedLinkId: "l1" }).zoe).toBeUndefined();
		expect(roles(g, { removedUserId: "alice" }).zoe).toBeUndefined();
		expect(
			roles(graph(g.edges as GraphEdge[], [{ ...links[0]!, revoked: true }]))
				.zoe,
		).toBeUndefined();
	});

	it("never lets an edge override a root", () => {
		const g = graph([user(OWNER, "alice", "use"), user("alice", OWNER)]);
		expect(roles(g).owner).toBe("build");
	});
});

describe("diffRoles", () => {
	it("separates downgrades from removals and ignores gains", () => {
		const g = graph([
			user("alice", OWNER, "build"),
			user("bob", "alice", "build"),
			user("bob", OWNER, "use"),
			user("carol", "alice", "build"),
		]);
		const before = computeEffectiveRoles(g);
		const after = computeEffectiveRoles(g, { removedUserId: "alice" });
		expect(diffRoles(before, after)).toEqual([
			{ userId: "alice", oldRole: "build", newRole: null },
			{ userId: "bob", oldRole: "build", newRole: "use" },
			{ userId: "carol", oldRole: "build", newRole: null },
		]);
	});
});

describe("planKeptUserEdges", () => {
	const g = graph([
		user("alice", OWNER, "build"),
		user("bob", "alice", "build"),
		user("carol", "bob", "use"),
	]);
	const before = computeEffectiveRoles(g);
	const after = computeEffectiveRoles(g, { removedUserId: "alice" });
	const affected = diffRoles(before, after);

	it("re-roots only the listed dependents at their prior role", () => {
		const edges = planKeptUserEdges({
			callerId: OWNER,
			callerRole: "build",
			affected,
			keepUserIds: ["bob"],
		});
		expect(edges).toEqual([
			{ kind: "user", targetId: "bob", sharerId: OWNER, role: "build" },
		]);
		// With bob re-rooted, carol (granted by bob) is reachable again too.
		const kept = computeEffectiveRoles({
			...g,
			edges: [...g.edges.filter((e) => e.targetId !== "alice"), ...edges],
		});
		expect(kept.get("carol")).toBe("use");
		expect(kept.has("alice")).toBe(false);
	});

	it("never grants above the caller's role or to the caller", () => {
		const edges = planKeptUserEdges({
			callerId: "bob",
			callerRole: "use",
			affected,
			keepUserIds: ["bob", "carol"],
		});
		expect(edges).toEqual([
			{ kind: "user", targetId: "carol", sharerId: "bob", role: "use" },
		]);
	});

	it("skips people who keep at least the planned role anyway", () => {
		expect(
			planKeptUserEdges({
				callerId: OWNER,
				callerRole: "build",
				affected: [{ userId: "x", oldRole: "use", newRole: "use" }],
				keepUserIds: ["x"],
			}),
		).toEqual([]);
	});
});
