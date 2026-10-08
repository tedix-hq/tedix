import { parse as parseYaml } from "yaml";
import {
	readSkillSchedulePolicy,
	type SkillSchedulePolicy,
} from "./skill-schedule";
import { isRecord } from "./is-record";

/**
 * Parsed executable-skill capability manifest.
 *
 * Skills declare this in SKILL.md frontmatter under `capabilities`. The
 * skill-runtime uses it as the runtime authority for what tenant code can call.
 */
export type RationaleMode = "off" | "important" | "all";

/**
 * Optional tool-annotation assertion. When set, the runner / gateway fails
 * closed if an inner MCP call hits a tool whose registered annotations
 * contradict the assertion.
 *
 * - `destructive: false` asserts NO `annotations.destructiveHint === true`
 *   tools will be invoked from this workflow.
 * - `readOnly: true` asserts ALL invoked tools must have
 *   `annotations.readOnlyHint === true`.
 *
 * `destructive: false` is the fail-closed default; `readOnly: false` means no
 * read-only assertion. A skill must opt into destructive inner tools explicitly.
 * A violation surfaces as `ANNOTATION_VIOLATION` (see Sam Morrow Part 3 in
 * `docs/engineering/cognition/skills.md` "External Design Lessons").
 */
export interface ExpectedAnnotations {
	destructive?: boolean;
	readOnly?: boolean;
}

/**
 * Grounding policy — the skill's declared standard of proof.
 *
 * ```yaml
 * capabilities:
 *   grounding:
 *     required: true        # workflow must call env.EVIDENCE.score() before finishing
 *     minCausalScore: 1.0   # every causal claim must be backed by attributable evidence
 * ```
 *
 * The runtime enforces this HOST-side: `env.EVIDENCE` labels each source and
 * computes the score in the trusted bridge, and the dispatcher records a run
 * warning when a `required: true` skill never produced a grounding receipt.
 * Tenant code can neither author a verdict nor suppress the check.
 *
 * `required: false` (the default) preserves every skill written before the
 * primitive existed.
 */
export interface GroundingPolicy {
	/** The workflow must call `env.EVIDENCE.score()` before it finishes. */
	required: boolean;
	/** Minimum grounded-causal-claim ratio, 0..1. Defaults to the strictest. */
	minCausalScore: number;
	/**
	 * What a policy violation does to the run. `"warn"` (default) seals a
	 * durable verdict at `evidence/policy.json` and moves on; `"fail"` marks
	 * the RUN failed after the verdict is sealed — which also fires the
	 * `skill.failed` alerting path. Note the honest scope: enforcement runs in
	 * the dispatcher AFTER the workflow returned, so it cannot retract side
	 * effects the workflow already performed; withholding a publish on a bad
	 * grounding score remains the workflow's job (see grounding.md). The
	 * default is "warn" so pre-existing skills are untouched; opting into
	 * "fail" is the ratchet.
	 */
	enforce: GroundingEnforcement;
}

export type GroundingEnforcement = "warn" | "fail";

export type ExpectedWorkflowTerminalStatus =
	| "completed"
	| "failed"
	| "canceled";

/**
 * Run-outcome policy used by reliability views.
 *
 * The policy is pinned with every admitted run. A terminal run defaults to an
 * expected `completed` outcome; when `params[parameter]` selects a declared
 * override, an intentional failure/cancellation counts as a successful
 * outcome without hiding the raw completion/failure counters.
 */
export interface WorkflowReliabilityPolicy {
	parameter: string;
	expectedTerminalStatuses: Record<string, ExpectedWorkflowTerminalStatus>;
}

/** Aggregate gateway methods supplied by the workflow platform, not D1 apps. */
export const WORKFLOW_PLATFORM_MCP_METHODS = {
	cognitive: ["record_artifact"],
} as const;

/**
 * Ephemeral-reasoner policy for `env.REASON` (see
 * `apps/skill-runtime/src/reason.ts`).
 *
 * Declared rather than implicit because unbounded LLM fan-out inside a step
 * the engine will retry is a cost vector, not just a capability. `maxCalls` is
 * a per-run ceiling that the runtime clamps again on its own side — a manifest
 * can only ever ask for LESS than the platform ceiling.
 */
export interface ReasonPolicy {
	enabled: boolean;
	maxCalls: number | null;
}

export interface CapabilityManifest {
	mcp: Record<string, string[]>;
	network: boolean;
	rationale: { mode: RationaleMode };
	expectedAnnotations: ExpectedAnnotations;
	grounding: GroundingPolicy;
	schedule: SkillSchedulePolicy | null;
	reliability: WorkflowReliabilityPolicy | null;
	reason: ReasonPolicy;
}

/** Undeclared means unavailable: env.REASON fails closed like env.MCP. */
export const DEFAULT_REASON_POLICY: ReasonPolicy = {
	enabled: false,
	maxCalls: null,
};

/**
 * Read `capabilities.reason` from a frontmatter/pinned value.
 *
 * Accepts `true` (enabled, runtime default budget) or a mapping. Anything else
 * — absent, `false`, a malformed scalar — is disabled, because the safe reading
 * of an unparseable reasoning grant is "no grant".
 */
export function readReasonPolicy(value: unknown): ReasonPolicy {
	if (value === true) return { enabled: true, maxCalls: null };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ...DEFAULT_REASON_POLICY };
	}
	const record = value as Record<string, unknown>;
	if (record.enabled === false) return { ...DEFAULT_REASON_POLICY };
	const declared = record.maxCalls;
	return {
		enabled: true,
		maxCalls:
			typeof declared === "number" && Number.isFinite(declared) && declared > 0
				? Math.floor(declared)
				: null,
	};
}

export const DEFAULT_GROUNDING_POLICY: GroundingPolicy = {
	required: false,
	minCausalScore: 1,
	// "warn" is the safe READ-TIME default: for `enforce`, the strict reading
	// ("fail") would destroy work on a parse hiccup of an already-stored row,
	// which is the opposite of safe. Strictness lives at write time instead —
	// validateGroundingPolicy rejects an invalid value outright.
	enforce: "warn",
};

export const EMPTY_MANIFEST: CapabilityManifest = {
	mcp: {},
	network: false,
	rationale: { mode: "important" },
	expectedAnnotations: { destructive: false, readOnly: false },
	grounding: { ...DEFAULT_GROUNDING_POLICY },
	schedule: null,
	reliability: null,
	reason: { ...DEFAULT_REASON_POLICY },
};

export interface ManifestIssue {
	code: string;
	message: string;
	path: string;
}

export function validateWorkflowReliabilityPolicy(raw: unknown): {
	policy: WorkflowReliabilityPolicy | null;
	issues: ManifestIssue[];
} {
	const issues: ManifestIssue[] = [];
	if (raw === undefined || raw === null) return { policy: null, issues };
	if (!isRecord(raw)) {
		return {
			policy: null,
			issues: [
				{
					code: "SKILL_RELIABILITY_INVALID",
					message:
						"capabilities.reliability must be a mapping with `parameter` and `expectedTerminalStatuses`",
					path: "capabilities.reliability",
				},
			],
		};
	}
	for (const key of Object.keys(raw)) {
		if (key !== "parameter" && key !== "expectedTerminalStatuses") {
			issues.push({
				code: "SKILL_RELIABILITY_INVALID",
				message: `capabilities.reliability.${key} is not a known reliability option`,
				path: `capabilities.reliability.${key}`,
			});
		}
	}
	const parameter = raw.parameter;
	if (typeof parameter !== "string" || !parameter.trim()) {
		issues.push({
			code: "SKILL_RELIABILITY_INVALID",
			message:
				"capabilities.reliability.parameter must be a non-empty run parameter name",
			path: "capabilities.reliability.parameter",
		});
	}
	const expected = raw.expectedTerminalStatuses;
	const expectedTerminalStatuses: Record<
		string,
		ExpectedWorkflowTerminalStatus
	> = {};
	if (!isRecord(expected) || Object.keys(expected).length === 0) {
		issues.push({
			code: "SKILL_RELIABILITY_INVALID",
			message:
				"capabilities.reliability.expectedTerminalStatuses must be a non-empty mapping",
			path: "capabilities.reliability.expectedTerminalStatuses",
		});
	} else {
		for (const [selector, status] of Object.entries(expected)) {
			if (!selector.trim()) {
				issues.push({
					code: "SKILL_RELIABILITY_INVALID",
					message: "Reliability outcome selectors must be non-empty",
					path: "capabilities.reliability.expectedTerminalStatuses",
				});
				continue;
			}
			if (
				status !== "completed" &&
				status !== "failed" &&
				status !== "canceled"
			) {
				issues.push({
					code: "SKILL_RELIABILITY_INVALID",
					message: `Expected terminal status for ${JSON.stringify(selector)} must be "completed", "failed", or "canceled"`,
					path: `capabilities.reliability.expectedTerminalStatuses.${selector}`,
				});
				continue;
			}
			expectedTerminalStatuses[selector] = status;
		}
	}
	return {
		policy:
			issues.length === 0 && typeof parameter === "string"
				? {
						parameter: parameter.trim(),
						expectedTerminalStatuses,
					}
				: null,
		issues,
	};
}

/**
 * Strict grounding-policy validation for write-time (`record_skill` /
 * `improve_skill`) admission. Unlike {@link parseCapabilityManifest} — which is
 * total by contract because it also runs against already-persisted rows — this
 * reports every malformed value as a clear parse error, so a typo'd policy is
 * rejected at authoring time instead of silently defaulting to "no grounding
 * required" at dispatch.
 *
 * The returned policy is always the SAFE reading of the input: an unusable
 * `minCausalScore` clamps to the strictest value rather than the loosest.
 */
export function validateGroundingPolicy(raw: unknown): {
	policy: GroundingPolicy;
	issues: ManifestIssue[];
} {
	const policy: GroundingPolicy = { ...DEFAULT_GROUNDING_POLICY };
	const issues: ManifestIssue[] = [];
	if (raw === undefined || raw === null) return { policy, issues };

	if (!isRecord(raw)) {
		issues.push({
			code: "SKILL_GROUNDING_INVALID",
			message:
				"capabilities.grounding must be a mapping, e.g. `grounding:\\n  required: true\\n  minCausalScore: 1.0`",
			path: "capabilities.grounding",
		});
		return { policy, issues };
	}

	for (const key of Object.keys(raw)) {
		if (key !== "required" && key !== "minCausalScore" && key !== "enforce") {
			issues.push({
				code: "SKILL_GROUNDING_INVALID",
				message: `capabilities.grounding.${key} is not a known grounding option (expected "required", "minCausalScore", "enforce")`,
				path: `capabilities.grounding.${key}`,
			});
		}
	}

	if (raw.enforce !== undefined) {
		if (raw.enforce === "warn" || raw.enforce === "fail") {
			policy.enforce = raw.enforce;
		} else {
			issues.push({
				code: "SKILL_GROUNDING_INVALID",
				message: `capabilities.grounding.enforce must be "warn" or "fail" (got ${JSON.stringify(raw.enforce)})`,
				path: "capabilities.grounding.enforce",
			});
		}
	}

	if (raw.required !== undefined) {
		if (typeof raw.required !== "boolean") {
			issues.push({
				code: "SKILL_GROUNDING_INVALID",
				message: `capabilities.grounding.required must be a boolean (got ${JSON.stringify(raw.required)})`,
				path: "capabilities.grounding.required",
			});
		} else {
			policy.required = raw.required;
		}
	}

	if (raw.minCausalScore !== undefined) {
		const value = raw.minCausalScore;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			issues.push({
				code: "SKILL_GROUNDING_INVALID",
				message: `capabilities.grounding.minCausalScore must be a number between 0 and 1 (got ${JSON.stringify(value)})`,
				path: "capabilities.grounding.minCausalScore",
			});
		} else if (value < 0 || value > 1) {
			issues.push({
				code: "SKILL_GROUNDING_INVALID",
				message: `capabilities.grounding.minCausalScore must be between 0 and 1 (got ${value})`,
				path: "capabilities.grounding.minCausalScore",
			});
		} else {
			policy.minCausalScore = value;
		}
	}

	return { policy, issues };
}

/** Total, fail-safe read of a grounding block. Never throws. */
function readGroundingPolicy(raw: unknown): GroundingPolicy {
	return validateGroundingPolicy(raw).policy;
}

function readPinnedSchedule(value: unknown): SkillSchedulePolicy | null {
	if (value === null || value === undefined) return null;
	if (
		!isRecord(value) ||
		typeof value.cron !== "string" ||
		!isRecord(value.params) ||
		typeof value.enabled !== "boolean"
	) {
		return null;
	}
	return {
		cron: value.cron,
		params: value.params,
		enabled: value.enabled,
		executionKind:
			value.executionKind === "inference" ? "inference" : "deterministic",
	};
}

/**
 * Validate a run-pinned capability snapshot without applying today's parser
 * defaults. This snapshot is the execution authority across hibernation and
 * deploys; reparsing SKILL.md is only an integrity/drift signal.
 */
export function readPinnedCapabilityManifest(
	value: unknown,
): CapabilityManifest | null {
	if (!isRecord(value) || !isRecord(value.mcp)) return null;
	const mcp: Record<string, string[]> = {};
	for (const [namespace, methods] of Object.entries(value.mcp)) {
		if (
			!namespace ||
			!Array.isArray(methods) ||
			methods.some((method) => typeof method !== "string" || !method)
		) {
			return null;
		}
		mcp[namespace] = [...methods];
	}
	if (typeof value.network !== "boolean") return null;
	if (!isRecord(value.rationale)) return null;
	const mode = value.rationale.mode;
	if (mode !== "off" && mode !== "important" && mode !== "all") return null;
	if (!isRecord(value.expectedAnnotations)) return null;
	const destructive = value.expectedAnnotations.destructive;
	const readOnly = value.expectedAnnotations.readOnly;
	if (
		(destructive !== undefined && typeof destructive !== "boolean") ||
		(readOnly !== undefined && typeof readOnly !== "boolean")
	) {
		return null;
	}
	const schedule = readPinnedSchedule(value.schedule);
	if (value.schedule !== undefined && value.schedule !== null && !schedule) {
		return null;
	}
	const reliability = validateWorkflowReliabilityPolicy(value.reliability);
	if (reliability.issues.length > 0) return null;
	// `grounding` post-dates the first pinned snapshots. A run admitted before
	// the policy existed is valid and simply has no grounding requirement — only
	// a snapshot that carries a MALFORMED policy is rejected, because that one
	// would silently execute under a weaker standard of proof than it declared.
	if (value.grounding !== undefined) {
		const grounding = validateGroundingPolicy(value.grounding);
		if (grounding.issues.length > 0) return null;
		return {
			mcp,
			network: value.network,
			rationale: { mode },
			expectedAnnotations: {
				...(typeof destructive === "boolean" ? { destructive } : {}),
				...(typeof readOnly === "boolean" ? { readOnly } : {}),
			},
			grounding: grounding.policy,
			schedule,
			reliability: reliability.policy,
			// Pre-dates the pinned snapshots that carry it; absent means no grant.
			reason: readReasonPolicy(value.reason),
		};
	}
	return {
		mcp,
		network: value.network,
		rationale: { mode },
		expectedAnnotations: {
			...(typeof destructive === "boolean" ? { destructive } : {}),
			...(typeof readOnly === "boolean" ? { readOnly } : {}),
		},
		grounding: { ...DEFAULT_GROUNDING_POLICY },
		schedule,
		reliability: reliability.policy,
		reason: readReasonPolicy(value.reason),
	};
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function extractFrontmatter(source: string): string | null {
	const match = source.match(FRONTMATTER_RE);
	return match?.[1] ?? null;
}

export function parseSkillFrontmatter(
	source: string,
): Record<string, unknown> | null {
	const fm = extractFrontmatter(source);
	if (!fm) return null;

	let parsed: unknown;
	try {
		parsed = parseYaml(fm);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as Record<string, unknown>;
}

function cloneEmptyManifest(): CapabilityManifest {
	return {
		mcp: {},
		network: EMPTY_MANIFEST.network,
		rationale: { ...EMPTY_MANIFEST.rationale },
		expectedAnnotations: { ...EMPTY_MANIFEST.expectedAnnotations },
		grounding: { ...EMPTY_MANIFEST.grounding },
		schedule: null,
		reliability: null,
		reason: { ...EMPTY_MANIFEST.reason },
	};
}

export function parseCapabilityManifest(source: string): CapabilityManifest {
	const fm = extractFrontmatter(source);
	if (!fm) return cloneEmptyManifest();

	let parsed: unknown;
	try {
		parsed = parseYaml(fm);
	} catch {
		return cloneEmptyManifest();
	}

	if (!parsed || typeof parsed !== "object") return cloneEmptyManifest();
	const root = parsed as Record<string, unknown>;
	const caps = root.capabilities;
	if (!caps || typeof caps !== "object") return cloneEmptyManifest();

	const capsObj = caps as Record<string, unknown>;
	const mcpRaw = capsObj.mcp;
	const mcp: Record<string, string[]> = {};
	if (mcpRaw && typeof mcpRaw === "object" && !Array.isArray(mcpRaw)) {
		for (const [namespace, methods] of Object.entries(
			mcpRaw as Record<string, unknown>,
		)) {
			if (Array.isArray(methods)) {
				mcp[namespace] = methods.filter(
					(method): method is string => typeof method === "string",
				);
			}
		}
	}

	const network = capsObj.network === true;

	let rationaleMode: RationaleMode = "important";
	const rationaleRaw = capsObj.rationale;
	if (rationaleRaw && typeof rationaleRaw === "object") {
		const mode = (rationaleRaw as Record<string, unknown>).mode;
		if (mode === "off" || mode === "important" || mode === "all") {
			rationaleMode = mode;
		} else if (mode === false) {
			rationaleMode = "off";
		} else if (typeof mode === "string") {
			const normalized = mode.toLowerCase();
			if (
				normalized === "off" ||
				normalized === "important" ||
				normalized === "all"
			) {
				rationaleMode = normalized;
			}
		}
	}

	const expectedAnnotations: ExpectedAnnotations = {
		destructive: false,
		readOnly: false,
	};
	const expectedRaw = capsObj.expectedAnnotations;
	if (expectedRaw && typeof expectedRaw === "object") {
		const e = expectedRaw as Record<string, unknown>;
		if (typeof e.destructive === "boolean") {
			expectedAnnotations.destructive = e.destructive;
		}
		if (typeof e.readOnly === "boolean") {
			expectedAnnotations.readOnly = e.readOnly;
		}
	}

	return {
		mcp,
		network,
		rationale: { mode: rationaleMode },
		expectedAnnotations,
		grounding: readGroundingPolicy(capsObj.grounding),
		schedule: readSkillSchedulePolicy(source),
		reliability: validateWorkflowReliabilityPolicy(capsObj.reliability).policy,
		reason: readReasonPolicy(capsObj.reason),
	};
}

/**
 * Validate a tool's annotations against the manifest's `expectedAnnotations`
 * assertion. Returns null when allowed, or a violation reason string otherwise.
 */
export function checkAnnotationAssertion(
	expected: ExpectedAnnotations | undefined,
	annotations: { destructiveHint?: boolean; readOnlyHint?: boolean } | null,
): string | null {
	if (!expected) return null;
	if (expected.destructive === false && annotations?.destructiveHint === true) {
		return "tool is destructive (annotations.destructiveHint=true) but the skill manifest asserts expectedAnnotations.destructive=false";
	}
	if (expected.readOnly === true && annotations?.readOnlyHint !== true) {
		return "tool is not read-only (annotations.readOnlyHint !== true) but the skill manifest asserts expectedAnnotations.readOnly=true";
	}
	return null;
}

export function isMethodAllowed(
	manifest: CapabilityManifest,
	namespace: string,
	method: string,
): boolean {
	const allowed = manifest.mcp[namespace];
	if (!allowed) return false;
	if (allowed.includes(method)) return true;
	const head = method.split(".")[0];
	return head ? allowed.includes(head) : false;
}
