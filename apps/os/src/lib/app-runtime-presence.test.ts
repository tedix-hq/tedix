import { describe, expect, it } from "vite-plus/test";
import type { CollabParticipant } from "@/collab/presence";
import { appPresenceDocKey, mergeAppPresence } from "./app-runtime-presence";

function person(key: string, selectionLabel?: string): CollabParticipant {
	return {
		key,
		displayName: key,
		kind: "human",
		role: "member",
		verified: true,
		clientIds: [1],
		sessions: 1,
		selection: null,
		location: selectionLabel
			? { surface: "canvas", artifactKind: "gadget", selectionLabel }
			: null,
	} as CollabParticipant;
}

describe("app presence", () => {
	it("names the app's own room after the gadget", () => {
		expect(appPresenceDocKey("g1")).toBe("app:g1");
	});

	it("lists each person once, preferring the app room's tab location", () => {
		const merged = mergeAppPresence(
			[person("maya", "Drafts"), person("sam", "Code")],
			[person("maya"), person("alex")],
		);
		expect(merged.map((participant) => participant.key)).toEqual([
			"maya",
			"sam",
			"alex",
		]);
		expect(merged[0]?.location?.selectionLabel).toBe("Drafts");
	});

	it("falls back to the editing room alone", () => {
		expect(mergeAppPresence([], [person("alex")]).map((p) => p.key)).toEqual([
			"alex",
		]);
	});
});
