import { expect, it } from "vite-plus/test";
import {
	buildSystemMap,
	validateSystemMap,
	type SystemMapSources,
} from "./system-map";

const empty: SystemMapSources = {
	tedis: [],
	skills: [],
	connections: [],
	workspaces: [],
};

const sources: SystemMapSources = {
	tedis: [
		{ id: "t1", name: "miles", displayName: "Miles", ownerUserId: "u1" },
		{ id: "t2", name: "juno", installedSkills: ["inbox-triage"] },
	],
	skills: [
		{ id: "s1", title: "Revenue report", tediId: "t1", appId: "app-shop" },
		{ id: "s2", title: "Inbox triage", slug: "inbox-triage" },
	],
	connections: [
		{
			id: "gmail",
			name: "Gmail",
			accountState: "expired",
			referenceAppIds: ["app-shop"],
		},
	],
	workspaces: [
		{ id: "w1", name: "Miles notes", visibility: "private", ownerUserId: "u1" },
		{ id: "w2", name: "Company", visibility: "org" },
	],
};

it("handles an empty organization", () => {
	const map = buildSystemMap(empty);
	expect(map).toEqual({ nodes: [], edges: [] });
	expect(validateSystemMap(map)).toEqual([]);
});

it("wires tedis to skills, skills to connections and tedis to private workspaces", () => {
	const map = buildSystemMap(sources);
	expect(map.edges).toEqual(
		expect.arrayContaining([
			{ from: "tedi:t1", to: "skill:s1", kind: "uses" },
			{ from: "tedi:t2", to: "skill:s2", kind: "uses" },
			{ from: "skill:s1", to: "connection:gmail", kind: "needs" },
			{ from: "tedi:t1", to: "workspace:w1", kind: "owns" },
		]),
	);
	expect(map.edges).toHaveLength(4);
	expect(validateSystemMap(map)).toEqual([]);
});

it("reports a dangling edge for an installed skill that does not exist", () => {
	const map = buildSystemMap({
		...empty,
		tedis: [{ id: "t1", name: "miles", installedSkills: ["gone-skill"] }],
	});
	expect(validateSystemMap(map)).toContainEqual(
		expect.objectContaining({
			kind: "dangling_edge",
			missing: "to",
			missingRef: "gone-skill",
		}),
	);
});

it("reports a skill owned by a tedi that is not listed", () => {
	const map = buildSystemMap({
		...empty,
		skills: [{ id: "s1", title: "Orphaned", tediId: "retired" }],
	});
	expect(validateSystemMap(map)).toContainEqual(
		expect.objectContaining({
			kind: "dangling_edge",
			missing: "from",
			missingRef: "retired",
		}),
	);
});

it("reports orphans but not shared workspaces", () => {
	const map = buildSystemMap({
		...empty,
		tedis: [{ id: "t1", name: "miles" }],
		connections: [
			{ id: "c", name: "Notion", accountState: "present", referenceAppIds: [] },
		],
		workspaces: [{ id: "w", name: "Company", visibility: "org" }],
	});
	const orphans = validateSystemMap(map).flatMap((f) =>
		f.kind === "orphan_node" ? [f.node.id] : [],
	);
	expect(orphans.sort()).toEqual(["connection:c", "tedi:t1"]);
});

it("reports an edge with neither end present", () => {
	expect(
		validateSystemMap({
			nodes: [],
			edges: [{ from: "tedi:a", to: "skill:b", kind: "uses" }],
		}),
	).toEqual([
		expect.objectContaining({ kind: "dangling_edge", present: null }),
	]);
});
