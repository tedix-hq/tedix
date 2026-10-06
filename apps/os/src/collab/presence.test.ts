import { describe, expect, it } from "vite-plus/test";
import {
	type CollabVerifiedIdentity,
	collabParticipantsFromStates,
	mapOffsetThroughTextChange,
	mapSelectionThroughChange,
	parseCollabPresenceHeader,
	sanitizeCollabPresenceState,
} from "./presence";
import { applyCodeChange, diffFiles, type TextChange } from "./ot/code-change";

const identity: CollabVerifiedIdentity = {
	displayName: "Ada",
	key: "opaque-ada",
	kind: "human",
	role: "owner",
	verified: true,
};

describe("collaboration presence", () => {
	it("fails closed on malformed or unverified room identity", () => {
		expect(parseCollabPresenceHeader(null)).toBeNull();
		expect(parseCollabPresenceHeader("not-json")).toBeNull();
		expect(
			parseCollabPresenceHeader(
				JSON.stringify({ ...identity, verified: false }),
			),
		).toBeNull();
		expect(parseCollabPresenceHeader(JSON.stringify(identity))).toEqual(
			identity,
		);
	});

	it("overwrites identity and removes arbitrary private presence fields", () => {
		const result = sanitizeCollabPresenceState(
			{
				user: { name: "Spoofed", email: "private@example.com" },
				location: {
					surface: "canvas",
					artifactKind: "gadget",
					artifactLabel: "Research gadget",
					secret: "never broadcast",
				},
				token: "never broadcast",
			},
			identity,
		);
		expect(result).toEqual({
			user: identity,
			location: {
				surface: "canvas",
				artifactKind: "gadget",
				artifactLabel: "Research gadget",
			},
		});
		expect(JSON.stringify(result)).not.toContain("private@example.com");
		expect(JSON.stringify(result)).not.toContain("token");
	});

	it("keeps a well-formed offset selection and drops a malformed one", () => {
		expect(
			sanitizeCollabPresenceState(
				{ selection: { path: "document", anchor: 4, head: 9, hidden: 1 } },
				identity,
			),
		).toEqual({
			user: identity,
			selection: { path: "document", anchor: 4, head: 9 },
		});
		for (const selection of [
			{ path: "document", anchor: -1, head: 2 },
			{ path: "document", anchor: 1.5, head: 2 },
			{ path: "", anchor: 1, head: 2 },
			{ anchor: 1, head: 2 },
			// A structurally unrelated object: it carries no offsets at all, so it
			// can never be mistaken for one.
			{ type: null, tname: "content", item: { client: 7, clock: 3 }, assoc: 0 },
		]) {
			expect(sanitizeCollabPresenceState({ selection }, identity)).toEqual({
				user: identity,
			});
		}
	});

	it("collapses duplicate sessions and ignores local or unverified states", () => {
		const states = new Map<number, unknown>([
			[1, { user: identity }],
			[2, { user: identity, location: { surface: "canvas" } }],
			[3, { user: { name: "Client-asserted only" } }],
			[4, { user: { ...identity, key: "local" } }],
		]);
		expect(collabParticipantsFromStates(states, 4)).toEqual([
			{
				...identity,
				clientIds: [1, 2],
				location: { surface: "canvas" },
				selection: null,
				sessions: 2,
			},
		]);
	});
});

describe("mapping positions through the change stream", () => {
	function editChange(before: string, after: string) {
		return diffFiles(
			new Map([["document", before]]),
			new Map([["document", after]]),
		);
	}

	it("carries an offset across an insert before it", () => {
		const change = editChange("hello world", "hello brave world");
		const mapped = mapSelectionThroughChange(
			{ path: "document", anchor: 6, head: 11 },
			change,
		);
		expect(mapped).toEqual({ path: "document", anchor: 6, head: 17 });
	});

	it("clamps an offset inside a replaced span into the replacement", () => {
		const change = editChange("abcdef", "aXf");
		// Every position within the deleted "bcde" lands inside "X", never past it.
		const edit = (change[0] as [string, { edit: TextChange }])[1].edit;
		for (const position of [1, 2, 3, 4, 5]) {
			const mapped = mapOffsetThroughTextChange(edit, position);
			expect(mapped).toBeGreaterThanOrEqual(1);
			expect(mapped).toBeLessThanOrEqual(3);
		}
	});

	it("keeps a mapped offset inside the text the change produced", () => {
		const before = "the quick brown fox";
		const after = "the extremely quick fox jumps";
		const change = editChange(before, after);
		const produced = applyCodeChange(
			new Map([["document", before]]),
			change,
		).get("document") as string;
		expect(produced).toBe(after);
		for (let position = 0; position <= before.length; position += 1) {
			const mapped = mapSelectionThroughChange(
				{ path: "document", anchor: position, head: position },
				change,
			);
			expect(mapped?.anchor).toBeGreaterThanOrEqual(0);
			expect(mapped?.anchor).toBeLessThanOrEqual(after.length);
		}
	});

	it("leaves a selection in another file untouched", () => {
		expect(
			mapSelectionThroughChange(
				{ path: "other", anchor: 3, head: 3 },
				editChange("abc", "abcdef"),
			),
		).toEqual({ path: "other", anchor: 3, head: 3 });
	});

	it("drops a selection whose file was replaced or removed", () => {
		const selection = { path: "document", anchor: 3, head: 3 };
		expect(
			mapSelectionThroughChange(selection, [["document", { set: "new" }]]),
		).toBeNull();
		expect(
			mapSelectionThroughChange(selection, [["document", { remove: true }]]),
		).toBeNull();
	});
});
