import { describe, expect, it } from "vite-plus/test";
import {
	effectiveSkillPaceLayer,
	isSkillContentMutation,
} from "./cognitive-skill-governance";
import { isLifecycleOverrideAuthority } from "./cognitive-shared";

/**
 * Execute-to-promote force override follows the capability-mutation-gate
 * allowlist: only a signed-in human (user JWT with sub) or an operator API
 * key may bypass lifecycle gating. Every other authType — including
 * service-binding, which a dropped identity header can silently promote a
 * tedi call into — fails closed.
 */
describe("isLifecycleOverrideAuthority", () => {
	it("allows a signed-in human", () => {
		expect(
			isLifecycleOverrideAuthority({
				authType: "user",
				user: { sub: "U123" } as never,
			}),
		).toBe(true);
	});

	it("rejects a user authType with no subject", () => {
		expect(
			isLifecycleOverrideAuthority({ authType: "user", user: {} as never }),
		).toBe(false);
		expect(
			isLifecycleOverrideAuthority({ authType: "user", user: undefined }),
		).toBe(false);
	});

	it("allows an operator API key", () => {
		expect(
			isLifecycleOverrideAuthority({ authType: "apikey", user: undefined }),
		).toBe(true);
	});

	it("rejects every agent/machine authType, including unresolved", () => {
		for (const authType of [
			"tedi",
			"m2m",
			"service",
			"service-binding",
			undefined,
		] as const) {
			expect(isLifecycleOverrideAuthority({ authType, user: undefined })).toBe(
				false,
			);
		}
	});
});

/**
 * Record-layer mutation gate: `skills.improve` rejects content/workflow
 * mutations to record-layer (crystallized) skills from any caller that fails
 * `isLifecycleOverrideAuthority` (same allowlist as above). These two pure
 * helpers decide when the gate arms.
 */
describe("effectiveSkillPaceLayer", () => {
	it("returns the required stored column", () => {
		expect(
			effectiveSkillPaceLayer({
				paceLayer: "record",
			}),
		).toBe("record");
	});
});

describe("isSkillContentMutation", () => {
	it("arms on content, files, inputSchema, and agentSkillsFormat", () => {
		expect(isSkillContentMutation({ content: "# v2" })).toBe(true);
		expect(
			isSkillContentMutation({ files: { "scripts/workflow.ts": "…" } }),
		).toBe(true);
		expect(isSkillContentMutation({ inputSchema: {} })).toBe(true);
		expect(isSkillContentMutation({ agentSkillsFormat: "…" })).toBe(true);
	});

	it("stays disarmed for metadata-only edits", () => {
		expect(isSkillContentMutation({})).toBe(false);
		expect(
			isSkillContentMutation({
				content: undefined,
				files: undefined,
			}),
		).toBe(false);
	});
});
