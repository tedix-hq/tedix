/**
 * Kernel — workstation adapter dispatch policy ("Home-initiated
 * workstation attachment security model").
 *
 * Policy-gated model: auto-dispatch for low-risk
 * embodied work, approval card for high-risk. The classifier is deliberately
 * conservative: auto-dispatch requires EVERY low-risk condition to hold;
 * anything unknown or unmet degrades to the existing approval-card flow (the
 * pre-policy behavior), so the gate can never be more permissive than its
 * inputs justify.
 *
 * Risk model:
 *  - LOW  → an authenticated human EXPLICITLY chose the target tedi, that
 *    workstation adapter is already provisioned AND currently running (no new
 *    spawn), and no high-risk signal is present. Auto-dispatch.
 *  - HIGH → anything else: kernel-initiated (LLM-suggested) dispatch, a cold/
 *    sleeping workstation adapter (a dispatch would trigger a spawn/wake), no
 *    authenticated human identity, or a high-risk route classification.
 *    Approval card before anything runs (pre-existing behavior).
 */

export type WorkstationDispatchRisk = "low" | "high";

export interface WorkstationDispatchDecision {
	risk: WorkstationDispatchRisk;
	/** True only when every low-risk condition holds. */
	autoDispatch: boolean;
	/** Human-readable audit trail of WHY (persisted on run metadata). */
	reasons: string[];
}

export function classifyWorkstationDispatch(args: {
	/** input.delegateToTediId was set by the caller (human picked the tedi). */
	explicitHumanDelegation: boolean;
	/** An authenticated user identity is on the request (speaker authority). */
	hasActingUser: boolean;
	/**
	 * The target workstation adapter is currently running (fresh heartbeat) — a
	 * dispatch will NOT trigger a new runtime spawn/wake. `null` = unknown.
	 */
	runtimeRunning: boolean | null;
	/**
	 * The target is an ISOLATE whose workstation is warm/available (a current
	 * `workstation_leases` seat). A dispatch attaches to an already-available
	 * workstation with no runtime spawn/wake. Optional + defaults `null`/absent.
	 */
	isolateWorkstationWarm?: boolean | null;
	/** Kernel route risk when the route planner ran (null for explicit delegation). */
	routeRisk?: "low" | "medium" | "high" | null;
}): WorkstationDispatchDecision {
	const reasons: string[] = [];

	if (!args.explicitHumanDelegation) {
		reasons.push("kernel-initiated dispatch (no explicit human target)");
	}
	if (!args.hasActingUser) {
		reasons.push("no authenticated human identity on the request");
	}
	// The "no spawn/wake" low-risk condition is satisfied by either a running
	// runtime surface or a warm/available workstation lease.
	const targetWarm =
		args.runtimeRunning === true || args.isolateWorkstationWarm === true;
	if (!targetWarm) {
		if (
			args.runtimeRunning === false ||
			args.isolateWorkstationWarm === false
		) {
			reasons.push(
				"target workstation is not warm (dispatch would spawn/wake it)",
			);
		} else {
			reasons.push("target workstation warm-state unknown");
		}
	}
	if (args.routeRisk === "high") {
		reasons.push("route planner classified the work as high risk");
	}

	if (reasons.length > 0) {
		return { risk: "high", autoDispatch: false, reasons };
	}
	return {
		risk: "low",
		autoDispatch: true,
		reasons: [
			"explicit human delegation by an authenticated operator to an already-warm workstation adapter",
		],
	};
}

// ---------------------------------------------------------------------------
// Layered dispatch policy precedence (session → tedi → org).
//
// The pre-existing model was two layers: the org governance pack (a single
// active policy pack, read by `readOrgGovernancePolicy`) plus the per-tedi
// `requiresApproval` flag on the capability card. This adds a THIRD,
// higher-precedence layer scoped to a single session/conversation, so an
// operator (or an upstream policy) can tighten — never silently loosen — the
// dispatch posture for one conversation without touching org config.
//
// Precedence is session → tedi → org with two safety rules:
//   - DENY short-circuits. Any layer that explicitly denies autonomous
//     dispatch wins, regardless of precedence — a higher-precedence ALLOW can
//     never override a lower-precedence DENY. This is the fail-closed posture:
//     a deny anywhere is a hard "route to a human".
//   - Fail-closed default. When NO layer expresses an opinion the resolution is
//     `defer` (layer = null); the caller keeps its existing fail-closed gate.
//     Absent inputs therefore leave default behavior exactly unchanged.
// An ALLOW only matters when no layer denies: the highest-precedence explicit
// allow is surfaced. An allow is permissive, not authoritative — the consuming
// gate (`decideDelegationDispatch`) still applies every other fail-closed check,
// so a session ALLOW can never by itself force an auto-dispatch.
// ---------------------------------------------------------------------------

export type DispatchPolicyEffect = "allow" | "deny";

/**
 * Organization-scoped rollout policy for the earned-authority ceiling.
 *
 * The Worker environment flag is only a kill switch. It cannot activate
 * enforcement by itself: an active organization policy pack must also name
 * the exact activity, and may further narrow the rollout to tedis and
 * environments. This prevents an empty-grant organization-wide authority
 * cliff while the first activities are being certified.
 */
export interface EarnedDelegationRolloutPolicy {
	mode: "shadow" | "enforce";
	activityIds: string[];
	tediIds: string[];
	environments: string[];
}

export interface DispatchPolicyLayer {
	/** Explicit gating decision for autonomous dispatch. Absent = no opinion. */
	effect?: DispatchPolicyEffect;
	/** Optional human-readable note carried onto the delegation receipt. */
	reason?: string;
	/** Exact organization-scoped rollout allowlist for earned authority. */
	earnedDelegation?: EarnedDelegationRolloutPolicy;
	/**
	 * Organization-designated agent approver for agent-routable Home
	 * delegation holds (`approvalRoute: "agent"`). Read from the org layer only;
	 * `resolveDelegationApprover` still re-validates it on every hold, and any
	 * invalid designation falls back to the operator card.
	 */
	delegationApprover?: DelegationApproverDesignation;
}

export interface DelegationApproverDesignation {
	type: "tedi";
	id: string;
}

export type DispatchPolicyLayerName = "session" | "tedi" | "org";

export interface LayeredDispatchPolicyResolution {
	/** `defer` = no layer had an opinion; the caller keeps its own default. */
	effect: "allow" | "deny" | "defer";
	/** Which layer decided, or null when deferring. */
	layer: DispatchPolicyLayerName | null;
	reason: string;
}

/** Highest authority first. */
const POLICY_LAYER_ORDER: readonly DispatchPolicyLayerName[] = [
	"session",
	"tedi",
	"org",
];

/**
 * Resolve the three optional gating layers into a single effect. Pure, no I/O.
 * DENY short-circuits (fail-closed); otherwise the highest-precedence explicit
 * ALLOW governs; otherwise `defer`.
 */
export function resolveLayeredDispatchPolicy(layers: {
	session?: DispatchPolicyLayer | null;
	tedi?: DispatchPolicyLayer | null;
	org?: DispatchPolicyLayer | null;
}): LayeredDispatchPolicyResolution {
	const ordered = POLICY_LAYER_ORDER.map(
		(name) => [name, layers[name] ?? null] as const,
	);

	// DENY short-circuits. Surface the highest-precedence deny.
	for (const [name, layer] of ordered) {
		if (layer?.effect === "deny") {
			return {
				effect: "deny",
				layer: name,
				reason: layer.reason ?? `${name} policy denies autonomous dispatch`,
			};
		}
	}

	// No deny present — the highest-precedence explicit allow governs.
	for (const [name, layer] of ordered) {
		if (layer?.effect === "allow") {
			return {
				effect: "allow",
				layer: name,
				reason: layer.reason ?? `${name} policy allows autonomous dispatch`,
			};
		}
	}

	return {
		effect: "defer",
		layer: null,
		reason: "no layered dispatch policy opinion",
	};
}

/**
 * Parse a raw `gatingPolicy` JSON bag (a `PolicyPackDefinition.gatingPolicy`
 * slot, or a session-scoped equivalent) into a typed {@link DispatchPolicyLayer}.
 * No schema migration: the gating slot already exists on the policy pack.
 *
 * Recognized signals (first match wins), all fail-closed — an unrecognized bag
 * yields `null` (no opinion → `defer`), never a silent allow:
 *   - `dispatch: "allow" | "deny"`            (explicit)
 *   - `autoDispatch: true | false`            (true → allow, false → deny)
 *   - `requiresApproval: true | false`        (true → deny, false → allow)
 *
 * Independently of the effect, `delegationApprover: { type: "tedi", id }`
 * names the org's agent approver for agent-routable delegation holds.
 */
export function parseDispatchPolicyLayer(
	raw: unknown,
): DispatchPolicyLayer | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;

	let effect: DispatchPolicyEffect | undefined;
	if (record.dispatch === "allow" || record.dispatch === "deny") {
		effect = record.dispatch;
	} else if (record.autoDispatch === true) {
		effect = "allow";
	} else if (record.autoDispatch === false) {
		effect = "deny";
	} else if (record.requiresApproval === true) {
		effect = "deny";
	} else if (record.requiresApproval === false) {
		effect = "allow";
	}

	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0
			? record.reason.trim()
			: undefined;
	const rolloutRaw = record.earnedDelegation;
	let earnedDelegation: EarnedDelegationRolloutPolicy | undefined;
	if (
		rolloutRaw &&
		typeof rolloutRaw === "object" &&
		!Array.isArray(rolloutRaw)
	) {
		const rollout = rolloutRaw as Record<string, unknown>;
		const parseStringList = (key: string): string[] | null => {
			const value = rollout[key];
			if (value === undefined) return [];
			if (
				!Array.isArray(value) ||
				value.some(
					(item) => typeof item !== "string" || item.trim().length === 0,
				)
			) {
				return null;
			}
			return [...new Set(value.map((item) => (item as string).trim()))];
		};
		const activityIds = parseStringList("activityIds");
		const tediIds = parseStringList("tediIds");
		const environments = parseStringList("environments");
		if (
			(rollout.mode === "shadow" || rollout.mode === "enforce") &&
			activityIds !== null &&
			tediIds !== null &&
			environments !== null &&
			(rollout.mode === "shadow" || activityIds.length > 0)
		) {
			earnedDelegation = {
				mode: rollout.mode,
				activityIds,
				tediIds,
				environments,
			};
		}
	}
	const delegationApprover = parseDelegationApprover(record.delegationApprover);
	if (effect === undefined && !earnedDelegation && !delegationApprover)
		return null;
	return {
		...(effect ? { effect } : {}),
		...(reason ? { reason } : {}),
		...(earnedDelegation ? { earnedDelegation } : {}),
		...(delegationApprover ? { delegationApprover } : {}),
	};
}

/**
 * Parse `gatingPolicy.delegationApprover: { type: "tedi", id }`. Only a tedi
 * designation is recognized; anything else is no designation (the operator
 * keeps the card), never a partial one.
 */
function parseDelegationApprover(
	raw: unknown,
): DelegationApproverDesignation | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (record.type !== "tedi" || typeof record.id !== "string") return undefined;
	const id = record.id.trim();
	return id.length > 0 ? { type: "tedi", id } : undefined;
}

/**
 * Resolve the effective earned-authority posture for one concrete route.
 *
 * Enforcement requires both the deployment kill switch and a match in the
 * active organization policy pack. An activity-only rollout gates exact
 * activity matches. Once a policy names tedis, however, those tedis are
 * fail-closed subjects in the configured environments: a missing or
 * non-allowlisted activity must still reach the earned-authority ceiling
 * instead of escaping into shadow mode.
 */
export function resolveEarnedDelegationEnforcement(input: {
	globalMode: "shadow" | "enforce";
	policy: EarnedDelegationRolloutPolicy | null | undefined;
	activityId: string | null | undefined;
	tediId: string | null | undefined;
	environment: string;
}): "shadow" | "enforce" {
	if (input.globalMode !== "enforce" || input.policy?.mode !== "enforce") {
		return "shadow";
	}
	if (
		input.policy.environments.length > 0 &&
		!input.policy.environments.includes(input.environment)
	) {
		return "shadow";
	}
	if (
		input.policy.tediIds.length > 0 &&
		(!input.tediId || !input.policy.tediIds.includes(input.tediId))
	) {
		return "shadow";
	}
	if (input.policy.tediIds.length > 0) {
		return "enforce";
	}
	return input.activityId && input.policy.activityIds.includes(input.activityId)
		? "enforce"
		: "shadow";
}
