import { describe, expect, test } from "vite-plus/test";
import {
	isMethodAllowed,
	parseCapabilityManifest,
	readPinnedCapabilityManifest,
	validateGroundingPolicy,
	readReasonPolicy,
	validateWorkflowReliabilityPolicy,
} from "./skill-manifest";

describe("skill capability manifest", () => {
	test("parses canonical nested frontmatter", () => {
		const manifest = parseCapabilityManifest(`---
capabilities:
  network: true
  rationale:
    mode: all
  mcp:
    tedix:
      - get_organization_by_slug
      - catalog
    github:
      - repos.list
---
# Test Skill
`);

		expect(manifest).toEqual({
			network: true,
			rationale: { mode: "all" },
			expectedAnnotations: { destructive: false, readOnly: false },
			grounding: { required: false, minCausalScore: 1, enforce: "warn" },
			schedule: null,
			reliability: null,
			reason: { enabled: false, maxCalls: null },
			reason: { enabled: false, maxCalls: null },
			mcp: {
				tedix: ["get_organization_by_slug", "catalog"],
				github: ["repos.list"],
			},
		});
		expect(isMethodAllowed(manifest, "tedix", "get_organization_by_slug")).toBe(
			true,
		);
		expect(isMethodAllowed(manifest, "tedix", "catalog.reconcile_app")).toBe(
			true,
		);
		expect(isMethodAllowed(manifest, "tedix", "delete_organization")).toBe(
			false,
		);
	});

	test("defaults closed when frontmatter is absent or invalid", () => {
		expect(parseCapabilityManifest("# No manifest")).toEqual({
			network: false,
			rationale: { mode: "important" },
			expectedAnnotations: { destructive: false, readOnly: false },
			grounding: { required: false, minCausalScore: 1, enforce: "warn" },
			schedule: null,
			reliability: null,
			reason: { enabled: false, maxCalls: null },
			reason: { enabled: false, maxCalls: null },
			mcp: {},
		});

		expect(
			parseCapabilityManifest(`---
capabilities: [
---
# Broken
`),
		).toEqual({
			network: false,
			rationale: { mode: "important" },
			expectedAnnotations: { destructive: false, readOnly: false },
			grounding: { required: false, minCausalScore: 1, enforce: "warn" },
			schedule: null,
			reliability: null,
			reason: { enabled: false, maxCalls: null },
			reason: { enabled: false, maxCalls: null },
			mcp: {},
		});
	});

	test("parses annotation assertions", () => {
		const manifest = parseCapabilityManifest(`---
capabilities:
  expectedAnnotations:
    destructive: false
    readOnly: true
---
# Test Skill
`);

		expect(manifest.expectedAnnotations).toEqual({
			destructive: false,
			readOnly: true,
		});
	});

	test("normalizes YAML boolean false as rationale off", () => {
		const manifest = parseCapabilityManifest(`---
capabilities:
  rationale:
    mode: false
---
# Test Skill
`);

		expect(manifest.rationale.mode).toBe("off");
	});

	test("validates pinned manifests without applying new defaults", () => {
		const pinned = {
			mcp: { home: ["read_home_run_set"] },
			network: false,
			rationale: { mode: "important" },
			expectedAnnotations: { destructive: false, readOnly: true },
		};
		// A snapshot pinned before `grounding` existed stays valid and simply
		// carries no grounding requirement — in-flight runs must not break.
		expect(readPinnedCapabilityManifest(pinned)).toEqual({
			...pinned,
			grounding: { required: false, minCausalScore: 1, enforce: "warn" },
			schedule: null,
			reliability: null,
			reason: { enabled: false, maxCalls: null },
			reason: { enabled: false, maxCalls: null },
		});
		expect(
			readPinnedCapabilityManifest({ ...pinned, network: "false" }),
		).toBeNull();
		expect(
			readPinnedCapabilityManifest({ ...pinned, mcp: { home: [42] } }),
		).toBeNull();
		expect(
			readPinnedCapabilityManifest({
				...pinned,
				grounding: { required: true, minCausalScore: 0.8, enforce: "warn" },
			}),
		).toEqual({
			...pinned,
			grounding: { required: true, minCausalScore: 0.8, enforce: "warn" },
			schedule: null,
			reliability: null,
			reason: { enabled: false, maxCalls: null },
			reason: { enabled: false, maxCalls: null },
		});
		// A snapshot carrying a MALFORMED policy is rejected: executing it would
		// run under a weaker standard of proof than the skill declared.
		expect(
			readPinnedCapabilityManifest({
				...pinned,
				grounding: { required: "yes" },
			}),
		).toBeNull();
		expect(
			readPinnedCapabilityManifest({
				...pinned,
				grounding: { required: true, minCausalScore: 4, enforce: "warn" },
			}),
		).toBeNull();
	});

	test("parses and strictly validates expected terminal outcomes", () => {
		const manifest = parseCapabilityManifest(`---
capabilities:
  reliability:
    parameter: mode
    expectedTerminalStatuses:
      timeout: failed
      rollback: canceled
---
# Outcome-aware workflow
`);
		expect(manifest.reliability).toEqual({
			parameter: "mode",
			expectedTerminalStatuses: {
				timeout: "failed",
				rollback: "canceled",
			},
		});
		expect(
			readPinnedCapabilityManifest({
				mcp: {},
				network: false,
				rationale: { mode: "important" },
				expectedAnnotations: {},
				reliability: manifest.reliability,
			})?.reliability,
		).toEqual(manifest.reliability);
		expect(
			validateWorkflowReliabilityPolicy({
				parameter: "mode",
				expectedTerminalStatuses: { timeout: "timed-out" },
			}).issues,
		).toEqual([expect.objectContaining({ code: "SKILL_RELIABILITY_INVALID" })]);
	});

	test("parses the grounding policy", () => {
		const manifest = parseCapabilityManifest(`---
capabilities:
  grounding:
    required: true
    minCausalScore: 1.0
---
# Test Skill
`);
		expect(manifest.grounding).toEqual({
			required: true,
			minCausalScore: 1,
			enforce: "warn",
		});

		// Absent policy defaults open — every skill authored before the primitive
		// existed keeps working.
		expect(
			parseCapabilityManifest(`---
capabilities:
  network: true
---
# Test Skill
`).grounding,
		).toEqual({ required: false, minCausalScore: 1, enforce: "warn" });

		// Partial policy takes the STRICTEST reading of what is missing.
		expect(
			parseCapabilityManifest(`---
capabilities:
  grounding:
    required: true
---
# Test Skill
`).grounding,
		).toEqual({ required: true, minCausalScore: 1, enforce: "warn" });
	});

	test("parses and validates the enforce ratchet", () => {
		expect(validateGroundingPolicy({ enforce: "fail" }).policy.enforce).toBe(
			"fail",
		);
		expect(validateGroundingPolicy({ enforce: "warn" }).policy.enforce).toBe(
			"warn",
		);
		// Invalid enforce is a WRITE-TIME error, and the returned policy keeps the
		// safe reading ("warn"): the strict reading ("fail") would destroy work on
		// a parse hiccup of an already-stored row.
		const bad = validateGroundingPolicy({ required: true, enforce: "explode" });
		expect(bad.issues.map((issue) => issue.code)).toContain(
			"SKILL_GROUNDING_INVALID",
		);
		expect(bad.policy.enforce).toBe("warn");
		// Pre-ratchet pinned snapshots (no enforce) stay valid, defaulting to warn;
		// a malformed enforce rejects the snapshot outright.
		expect(
			readPinnedCapabilityManifest({
				mcp: {},
				network: false,
				rationale: { mode: "off" },
				expectedAnnotations: {},
				grounding: { required: true, minCausalScore: 1 },
			})?.grounding.enforce,
		).toBe("warn");
		expect(
			readPinnedCapabilityManifest({
				mcp: {},
				network: false,
				rationale: { mode: "off" },
				expectedAnnotations: {},
				grounding: { required: true, minCausalScore: 1, enforce: "explode" },
			}),
		).toBeNull();
	});

	test("reports malformed grounding policies as parse errors", () => {
		expect(validateGroundingPolicy(undefined)).toEqual({
			policy: { required: false, minCausalScore: 1, enforce: "warn" },
			issues: [],
		});
		expect(
			validateGroundingPolicy({ required: true, minCausalScore: 0.75 }),
		).toEqual({
			policy: { required: true, minCausalScore: 0.75, enforce: "warn" },
			issues: [],
		});

		const notAMapping = validateGroundingPolicy("required");
		expect(notAMapping.issues).toHaveLength(1);
		expect(notAMapping.issues[0]?.code).toBe("SKILL_GROUNDING_INVALID");
		expect(notAMapping.issues[0]?.path).toBe("capabilities.grounding");

		const badRequired = validateGroundingPolicy({ required: "yes" });
		expect(badRequired.issues[0]?.path).toBe("capabilities.grounding.required");
		// The unusable value never becomes a silent "no grounding required" pass;
		// it is an admission error AND reads as the safe default.
		expect(badRequired.policy.required).toBe(false);

		const outOfRange = validateGroundingPolicy({
			required: true,
			minCausalScore: 1.5,
		});
		expect(outOfRange.issues[0]?.path).toBe(
			"capabilities.grounding.minCausalScore",
		);
		// An unusable threshold clamps to the STRICTEST value, never the loosest.
		expect(outOfRange.policy.minCausalScore).toBe(1);

		expect(
			validateGroundingPolicy({ minCausalScore: "1.0" }).issues[0]?.message,
		).toContain("must be a number between 0 and 1");

		const unknownKey = validateGroundingPolicy({
			required: true,
			minCasualScore: 1,
		});
		expect(unknownKey.issues[0]?.path).toBe(
			"capabilities.grounding.minCasualScore",
		);
		expect(unknownKey.issues[0]?.message).toContain(
			"not a known grounding option",
		);
	});
	test("reads capabilities.reason, failing closed on anything unparseable", () => {
		// env.REASON is a COST grant as much as a capability: an undeclared or
		// malformed value must not hand a workflow an LLM fan-out inside a step
		// the engine will retry.
		for (const value of [
			undefined,
			null,
			false,
			"yes",
			3,
			[],
			{ enabled: false },
		]) {
			expect(readReasonPolicy(value)).toEqual({
				enabled: false,
				maxCalls: null,
			});
		}
		// `true` and a bare mapping enable it but name no budget — the runtime
		// then applies its conservative default rather than its ceiling.
		expect(readReasonPolicy(true)).toEqual({ enabled: true, maxCalls: null });
		expect(readReasonPolicy({})).toEqual({ enabled: true, maxCalls: null });
		expect(readReasonPolicy({ maxCalls: 5 })).toEqual({
			enabled: true,
			maxCalls: 5,
		});
		// A nonsense budget is dropped, not trusted; the runtime clamps again on
		// its own side, so a manifest can only ever ask for LESS.
		for (const bad of [0, -1, Number.NaN, "lots"]) {
			expect(readReasonPolicy({ maxCalls: bad })).toEqual({
				enabled: true,
				maxCalls: null,
			});
		}
	});

	test("carries a declared reason budget out of frontmatter", () => {
		const manifest = parseCapabilityManifest(`---
name: fan-out
capabilities:
  reason:
    maxCalls: 5
  mcp:
    tedix:
      - catalog
---
`);
		expect(manifest.reason).toEqual({ enabled: true, maxCalls: 5 });
		// A skill that never mentions reasoning gets no grant.
		expect(
			parseCapabilityManifest(
				"---\nname: x\ncapabilities:\n  network: false\n---\n",
			).reason,
		).toEqual({ enabled: false, maxCalls: null });
	});
});
