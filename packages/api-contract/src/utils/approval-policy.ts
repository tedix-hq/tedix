// ---------------------------------------------------------------------------
// Kernel governance policy (parsed from PolicyPackDefinition.governancePolicy)
// ---------------------------------------------------------------------------

/**
 * Governance policy fields recognized by the kernel's approval and delegation
 * paths. Stored as the `governancePolicy` JSON bag on a policy pack; unknown
 * keys are ignored so adding fields here is backward compatible.
 *
 * approvalTtlHours   — how long a pending approval request stays open before
 *                      it auto-expires (deny on timeout). Default 24h; max
 *                      168h (1 week). Mirrors a common ask_timeout:86400 default.
 * maxDelegationsPerTurn — maximum number of child tedi delegations one Home
 *                      turn may issue, counting the dispatch tool call itself
 *                      as the first delegation (analogous to a common
 *                      spawn_bounds.max_dispatches_per_turn pattern). Default 4;
 *                      max 20. Fail-closed past the cap.
 * writeTier          — the trusted-write auto-approve tier. A LOW-RISK write on
 *                      an explicitly trusted tool auto-resolves through the same
 *                      approval latch (resolvedBy:'policy') instead of parking
 *                      behind a human card. Absent ⇒ EVERY write stays
 *                      human-gated (fail-closed default). See
 *                      {@link decideKernelWriteApproval}.
 */
export interface KernelGovernancePolicy {
	approvalTtlHours?: number;
	maxDelegationsPerTurn?: number;
	writeTier?: KernelWriteTierPolicy;
	/**
	 * Rollout switch for the MCP gateway's autonomous third-party write gate.
	 * Absent/false preserves the legacy scoped agent auto-confirm posture;
	 * true requires each destructive external/non-managed-MCP tool to declare
	 * an explicit D1 approvalPolicy before Code Mode may dispatch it.
	 */
	requireExplicitThirdPartyApprovalPolicy?: boolean;
}

/** Coarse risk classification of a proposed provider write. */
export type KernelWriteRiskTier = "low" | "high";

/**
 * Trusted-write auto-approve tier. The kernel's symmetric analogue of the
 * delegation governance hook (`deriveRequiresApproval`): writes default to
 * human-gated, and ONLY a tool explicitly named in {@link trustedTools} is
 * eligible for auto-approve — and even then only when the write is LOW risk.
 *
 * trustedTools       — allowlist of tools eligible for low-risk auto-approve.
 *                      Entries are case-insensitive and take the forms
 *                      `"app:tool"` (exact), `"app:*"` (any tool on an app), or
 *                      `"*"` (any write — use sparingly). Capped at
 *                      {@link MAX_TRUSTED_TOOLS}.
 * autoApproveLowRisk — master switch. Defaults to ON when trustedTools is
 *                      present; set to `false` to keep the allowlist defined but
 *                      hard-disable auto-approve (kill switch) without dropping
 *                      the list.
 */
export interface KernelWriteTierPolicy {
	trustedTools?: string[];
	autoApproveLowRisk?: boolean;
}

const APPROVAL_TTL_DEFAULT_HOURS = 24;
const APPROVAL_TTL_MIN_HOURS = 1;
const APPROVAL_TTL_MAX_HOURS = 168; // 1 week

const FAN_OUT_CAP_DEFAULT = 4;
const FAN_OUT_CAP_MIN = 1;
const FAN_OUT_CAP_MAX = 20;

/** Defense-in-depth cap on a trusted-tool allowlist length. */
const MAX_TRUSTED_TOOLS = 50;

/**
 * Clamp a numeric value to [min, max], rounding to an integer. Returns null
 * when value is not a finite number — callers decide whether to use a fallback.
 */
function clampIntOrNull(
	value: unknown,
	min: number,
	max: number,
): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	return clampIntOrNull(value, min, max) ?? fallback;
}

/**
 * Parse the raw `governancePolicy` JSON bag from a policy pack definition into
 * a typed {@link KernelGovernancePolicy}. Unknown keys are silently dropped.
 * Fields with invalid (non-numeric) values are omitted — callers fall back to
 * defaults via {@link resolveApprovalTtlHours} and {@link resolveKernelFanOutCap}.
 */
export function parseKernelGovernancePolicy(
	raw: unknown,
): KernelGovernancePolicy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const out: KernelGovernancePolicy = {};
	if (record.approvalTtlHours !== undefined) {
		const ttl = clampIntOrNull(
			record.approvalTtlHours,
			APPROVAL_TTL_MIN_HOURS,
			APPROVAL_TTL_MAX_HOURS,
		);
		if (ttl !== null) out.approvalTtlHours = ttl;
	}
	if (record.maxDelegationsPerTurn !== undefined) {
		const cap = clampIntOrNull(
			record.maxDelegationsPerTurn,
			FAN_OUT_CAP_MIN,
			FAN_OUT_CAP_MAX,
		);
		if (cap !== null) out.maxDelegationsPerTurn = cap;
	}
	if (record.writeTier !== undefined) {
		const writeTier = parseWriteTierPolicy(record.writeTier);
		if (writeTier) out.writeTier = writeTier;
	}
	if (typeof record.requireExplicitThirdPartyApprovalPolicy === "boolean") {
		out.requireExplicitThirdPartyApprovalPolicy =
			record.requireExplicitThirdPartyApprovalPolicy;
	}
	return out;
}

/**
 * Parse the `writeTier` sub-bag. Invalid/empty input yields `null` so the
 * caller omits the field entirely — keeping the fail-closed default (no
 * writeTier ⇒ every write human-gated).
 */
function parseWriteTierPolicy(raw: unknown): KernelWriteTierPolicy | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const out: KernelWriteTierPolicy = {};
	if (Array.isArray(record.trustedTools)) {
		const tools = record.trustedTools
			.filter((value): value is string => typeof value === "string")
			.map((value) => value.trim())
			.filter((value) => value.length > 0)
			.slice(0, MAX_TRUSTED_TOOLS);
		if (tools.length > 0) out.trustedTools = tools;
	}
	if (typeof record.autoApproveLowRisk === "boolean") {
		out.autoApproveLowRisk = record.autoApproveLowRisk;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** A proposed write the governance tier reasons about. */
export interface KernelWriteApprovalProposal {
	appSlug: string;
	toolName: string;
	riskTier: KernelWriteRiskTier;
}

/**
 * The gating decision for a proposed write. `autoResolve:false` means the write
 * parks behind a human approval card (today's universal behavior);
 * `autoResolve:true` means the audit row is STILL created but auto-resolved
 * (resolvedBy:'policy') — the per-click tax is removed, the audit trail is not.
 */
export interface KernelWriteApprovalDecision {
	autoResolve: boolean;
	source: "policy" | "session" | null;
	reason: string;
}

/**
 * Whether `app:tool` is covered by an allowlist entry. Entries are
 * case-insensitive: `"app:tool"` (exact), `"app:*"` (any tool on the app),
 * `"*:tool"` (one tool on any app), or `"*"` / `"*:*"` (any write).
 * Empty/whitespace entries are ignored.
 */
export function writeToolMatchesAllowlist(
	appSlug: string,
	toolName: string,
	allowlist: readonly string[] | null | undefined,
): boolean {
	if (!allowlist || allowlist.length === 0) return false;
	const app = appSlug.trim().toLowerCase();
	const tool = toolName.trim().toLowerCase();
	if (!app || !tool) return false;
	const exact = `${app}:${tool}`;
	const appWild = `${app}:*`;
	const toolWild = `*:${tool}`;
	for (const raw of allowlist) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*" || entry === "*:*") return true;
		if (entry === exact || entry === appWild || entry === toolWild) return true;
	}
	return false;
}

/**
 * Decide whether a proposed write auto-resolves or stays human-gated. The
 * kernel's symmetric analogue of `deriveRequiresApproval` for delegation.
 *
 * FAIL-CLOSED: the default is a human gate. A write auto-resolves only when
 *   1. it is session pre-authorized — the operator named this exact tool (or an
 *      `app:*` wildcard) in the conversation-scoped allowlist; OR
 *   2. it is policy-trusted AND low risk — the tool is in
 *      `writeTier.trustedTools`, the write is `riskTier:"low"`, and
 *      `writeTier.autoApproveLowRisk` is not disabled.
 *
 * A high-risk (destructive/irreversible) write NEVER auto-resolves via policy —
 * only an explicit session pre-authorization can carry one through, because
 * that is a deliberate per-conversation operator grant.
 */
export function decideKernelWriteApproval(input: {
	policy?: KernelGovernancePolicy | null;
	sessionAllowlist?: readonly string[] | null;
	proposal: KernelWriteApprovalProposal;
}): KernelWriteApprovalDecision {
	const { appSlug, toolName, riskTier } = input.proposal;
	// 1. Session-scoped pre-authorization — explicit, conversation-bounded grant.
	if (writeToolMatchesAllowlist(appSlug, toolName, input.sessionAllowlist)) {
		return {
			autoResolve: true,
			source: "session",
			reason: `session pre-authorized ${appSlug}:${toolName}`,
		};
	}
	// 2. Policy write-tier trusted-tool auto-approve (LOW RISK ONLY).
	const writeTier = input.policy?.writeTier;
	if (writeToolMatchesAllowlist(appSlug, toolName, writeTier?.trustedTools)) {
		if (writeTier?.autoApproveLowRisk === false) {
			return {
				autoResolve: false,
				source: null,
				reason:
					"trusted tool but writeTier.autoApproveLowRisk is disabled — human gate",
			};
		}
		if (riskTier !== "low") {
			return {
				autoResolve: false,
				source: null,
				reason: `trusted tool but ${riskTier}-risk write requires human approval`,
			};
		}
		return {
			autoResolve: true,
			source: "policy",
			reason: `policy-trusted low-risk write ${appSlug}:${toolName}`,
		};
	}
	// 3. FAIL-CLOSED DEFAULT.
	return {
		autoResolve: false,
		source: null,
		reason: writeTier
			? "write tool is not in the trusted-tool allowlist — human gate"
			: "no write-tier policy configured — human gate (fail-closed default)",
	};
}

/**
 * Return the approval TTL (in hours) from a governance policy, falling back to
 * the safe 24-hour default when the field is absent or invalid.
 */
export function resolveApprovalTtlHours(
	policy: KernelGovernancePolicy | null | undefined,
): number {
	return clampInt(
		policy?.approvalTtlHours,
		APPROVAL_TTL_MIN_HOURS,
		APPROVAL_TTL_MAX_HOURS,
		APPROVAL_TTL_DEFAULT_HOURS,
	);
}

/**
 * Return the per-turn delegation fan-out cap from a governance policy. The cap
 * counts the dispatch tool call itself (the first delegation), so a cap of 4
 * allows at most 4 child tedi dispatches per turn. Falls back to
 * {@link FAN_OUT_CAP_DEFAULT} when absent.
 */
export function resolveKernelFanOutCap(
	policy: KernelGovernancePolicy | null | undefined,
): number {
	return clampInt(
		policy?.maxDelegationsPerTurn,
		FAN_OUT_CAP_MIN,
		FAN_OUT_CAP_MAX,
		FAN_OUT_CAP_DEFAULT,
	);
}

export interface RuntimeApprovalResolverPrincipal {
	subject?: string;
	authType?: string;
	scopes?: string[];
	clientId?: string;
}

const INTERNAL_AUTH_TYPES = new Set(["gateway-token", "service-binding"]);
const APPROVAL_SCOPES = new Set([
	"*",
	"platform:admin",
	"mcp:messaging.admin",
	"mcp:messaging.write",
	"tedi:permissions.write",
	"tedis:write",
	"tedis:admin",
]);

export interface RuntimeApprovalAuthority {
	allowed: boolean;
	provenance: "attributed" | "unattributed";
	reason: string;
}

export interface RuntimeApprovalTimeoutDecision {
	expired: boolean;
	terminalStatus: "expired" | null;
	defaultDecision: "deny" | null;
	reason: string;
}

export interface RuntimeInputGateDecision {
	allowed: boolean;
	reason: string;
}

export type RuntimeApprovalReviewIntent =
	| "tool_write"
	| "workstation_attach"
	| "runtime_permission"
	| "browser_takeover"
	| "unknown";
export type RuntimeApprovalReviewState =
	| "requires_decision"
	| "resolved"
	| "closed";
export type RuntimeApprovalReviewDecisionMode =
	| "approve_or_reject"
	| "no_action";
export type RuntimeApprovalReviewOutcome =
	| "approved"
	| "rejected"
	| "cancelled"
	| "expired";
export type RuntimeApprovalReviewEvidenceKind =
	| "approval_request"
	| "conversation"
	| "home_run"
	| "runtime_run"
	| "tedi"
	| "delegate_tedi"
	| "tool_call"
	| "trace_bundle"
	| "workflow"
	| "browser_session"
	| "work_item";

export interface RuntimeBrowserTakeoverInteraction {
	type: "browser_takeover";
	reason: "login" | "mfa" | "captcha" | "consent" | "operator_takeover";
	sessionId: string;
	mode: "tab";
	targets: Array<{
		targetId: string;
		url: string;
		pageUrl: string | null;
		title: string | null;
	}>;
	urlExpiresAt: string;
}

export interface RuntimeApprovalReviewEvidenceRef {
	kind: RuntimeApprovalReviewEvidenceKind;
	id: string;
}

export interface RuntimeApprovalReviewSemantics {
	intent: RuntimeApprovalReviewIntent;
	state: RuntimeApprovalReviewState;
	decisionMode: RuntimeApprovalReviewDecisionMode;
	outcome: RuntimeApprovalReviewOutcome | null;
	safetyDefault: "deny_on_timeout";
	summary: string;
	operatorQuestion: string;
	timeout: RuntimeApprovalTimeoutDecision;
	evidenceRefs: RuntimeApprovalReviewEvidenceRef[];
	interaction: RuntimeBrowserTakeoverInteraction | null;
}

export type RuntimeApprovalResolutionStatus = "approved" | "rejected";
export type RuntimeApprovalAuditStatus =
	| RuntimeApprovalResolutionStatus
	| "cancelled"
	| "expired";
export type RuntimeApprovalAuditAction =
	`approval.${RuntimeApprovalAuditStatus}`;

export function runtimeApprovalResolutionStatus(
	approved: boolean,
): RuntimeApprovalResolutionStatus {
	return approved ? "approved" : "rejected";
}

export function runtimeApprovalAuditAction(input: {
	status: RuntimeApprovalAuditStatus;
}): RuntimeApprovalAuditAction {
	return `approval.${input.status}`;
}

export function runtimeApprovalResolverMetadata(input: {
	authority: RuntimeApprovalAuthority;
	extraMetadata?: Record<string, unknown>;
	principal?: RuntimeApprovalResolverPrincipal;
	source: string;
}): Record<string, unknown> {
	const principal = input.principal;
	const metadata: Record<string, unknown> = {
		...input.extraMetadata,
		source: input.source,
		resolverProvenance: input.authority.provenance,
		resolverPolicyReason: input.authority.reason,
	};
	if (principal?.authType) metadata.resolvedByAuthType = principal.authType;
	if (principal?.subject) metadata.resolvedBySubject = principal.subject;
	if (principal?.clientId) metadata.resolvedByClientId = principal.clientId;
	return metadata;
}

export function runtimeApprovalResolvedPayload(input: {
	approved: boolean;
	metadata?: Record<string, unknown>;
	resolution?: string;
}): {
	status: RuntimeApprovalResolutionStatus;
	approved: boolean;
	resolution?: string;
	metadata: Record<string, unknown>;
} {
	const payload: {
		status: RuntimeApprovalResolutionStatus;
		approved: boolean;
		resolution?: string;
		metadata: Record<string, unknown>;
	} = {
		status: runtimeApprovalResolutionStatus(input.approved),
		approved: input.approved,
		metadata: input.metadata ?? {},
	};
	if (input.resolution !== undefined) payload.resolution = input.resolution;
	return payload;
}

export function resolveRuntimeApprovalAuthority(input: {
	approved: boolean;
	principal?: RuntimeApprovalResolverPrincipal;
	tediId: string;
}): RuntimeApprovalAuthority {
	if (!input.approved) {
		return {
			allowed: true,
			provenance: input.principal ? "attributed" : "unattributed",
			reason: "deny decisions are safe to record without elevated authority",
		};
	}
	const principal = input.principal;
	if (!principal) {
		return {
			allowed: false,
			provenance: "unattributed",
			reason: "approval allow decision has no attributable resolver",
		};
	}
	const internalSelf =
		INTERNAL_AUTH_TYPES.has(principal.authType ?? "") &&
		(!principal.subject || principal.subject === input.tediId);
	if (internalSelf) {
		return {
			allowed: false,
			provenance: "unattributed",
			reason: "approval allow decision came from the runtime owner itself",
		};
	}
	const hasApprovalScope = (principal.scopes ?? []).some((scope) =>
		APPROVAL_SCOPES.has(scope),
	);
	if (!hasApprovalScope) {
		return {
			allowed: false,
			provenance: "attributed",
			reason: "resolver lacks a runtime approval scope",
		};
	}
	return {
		allowed: true,
		provenance: "attributed",
		reason: "resolver has runtime approval authority",
	};
}

export function parseRuntimeApprovalTimestamp(
	value: string | null | undefined,
): number | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const ms = Date.parse(normalized);
	return Number.isNaN(ms) ? null : ms;
}

export function resolveRuntimeApprovalTimeout(input: {
	status: string;
	expiresAt?: string | null;
	now?: number | Date;
}): RuntimeApprovalTimeoutDecision {
	if (input.status === "expired") {
		return {
			expired: true,
			terminalStatus: "expired",
			defaultDecision: "deny",
			reason: "approval row is already expired",
		};
	}
	if (input.status !== "pending") {
		return {
			expired: false,
			terminalStatus: null,
			defaultDecision: null,
			reason: `approval is already ${input.status}`,
		};
	}
	const expiresAt = parseRuntimeApprovalTimestamp(input.expiresAt);
	if (expiresAt === null) {
		return {
			expired: false,
			terminalStatus: null,
			defaultDecision: null,
			reason: "approval expiry timestamp is unavailable",
		};
	}
	const now =
		input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
	if (expiresAt > now) {
		return {
			expired: false,
			terminalStatus: null,
			defaultDecision: null,
			reason: "approval is still within its review window",
		};
	}
	return {
		expired: true,
		terminalStatus: "expired",
		defaultDecision: "deny",
		reason: "approval review window expired",
	};
}

export function resolveRuntimeInputGate(input: {
	channelId?: string;
	senderIsOwner?: boolean;
}): RuntimeInputGateDecision {
	const channelId = input.channelId ?? "";
	const internalChannel =
		channelId === "internal" ||
		channelId.startsWith("agent:") ||
		channelId.startsWith("system:");
	if (input.senderIsOwner === false && !internalChannel) {
		return {
			allowed: false,
			reason: "non-owner external sender cannot submit container work",
		};
	}
	return { allowed: true, reason: "sender is authorized for input" };
}

function recordFrom(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringFrom(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function boundedText(value: string, maxLength = 280): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function detectApprovalReviewIntent(input: {
	actionType: string;
	payload: Record<string, unknown>;
}): RuntimeApprovalReviewIntent {
	const actionType = input.actionType.toLowerCase();
	const kind = stringFrom(input.payload.kind)?.toLowerCase();
	const source = stringFrom(input.payload.source)?.toLowerCase();
	if (
		kind === "browser_live_view_takeover" ||
		actionType === "browser.live_view_takeover"
	) {
		return "browser_takeover";
	}
	if (
		kind === "home_tool_write" ||
		actionType === "home.tool_write" ||
		actionType.includes("tool_write")
	) {
		return "tool_write";
	}
	if (
		source === "home.workstation_attach" ||
		actionType === "workstation.attach" ||
		actionType.includes("container") ||
		actionType.includes("handoff")
	) {
		return "workstation_attach";
	}
	if (
		actionType.includes("permission") ||
		actionType.includes("approval") ||
		stringFrom(input.payload.permission) ||
		stringFrom(input.payload.toolCallId)
	) {
		return "runtime_permission";
	}
	return "unknown";
}

function approvalReviewQuestion(intent: RuntimeApprovalReviewIntent): string {
	switch (intent) {
		case "tool_write":
			return "Approve or reject this Home tool write. Approval executes the stored call once; rejection closes it without executing.";
		case "workstation_attach":
			return "Approve or reject this certified workstation attachment before the selected adapter starts work.";
		case "runtime_permission":
			return "Approve or reject this runtime permission request.";
		case "browser_takeover":
			return "Take control of this live browser session, complete the human-only step, then approve to let the tedi continue in the same session.";
		default:
			return "Approve or reject this runtime action.";
	}
}

function pushEvidenceRef(
	refs: RuntimeApprovalReviewEvidenceRef[],
	seen: Set<string>,
	kind: RuntimeApprovalReviewEvidenceKind,
	id: unknown,
): void {
	const value = stringFrom(id);
	if (!value) return;
	const key = `${kind}:${value}`;
	if (seen.has(key)) return;
	seen.add(key);
	refs.push({ kind, id: value });
}

function approvalReviewEvidenceRefs(input: {
	id: string;
	payload: Record<string, unknown>;
	tediId?: string;
	workflowId?: string | null;
}): RuntimeApprovalReviewEvidenceRef[] {
	const refs: RuntimeApprovalReviewEvidenceRef[] = [];
	const seen = new Set<string>();
	pushEvidenceRef(refs, seen, "approval_request", input.id);
	pushEvidenceRef(refs, seen, "tedi", input.tediId);
	pushEvidenceRef(refs, seen, "workflow", input.workflowId);
	pushEvidenceRef(refs, seen, "home_run", input.payload.homeRunId);
	pushEvidenceRef(refs, seen, "runtime_run", input.payload.runId);
	pushEvidenceRef(refs, seen, "conversation", input.payload.conversationId);
	pushEvidenceRef(refs, seen, "conversation", input.payload.homeConversationId);
	pushEvidenceRef(refs, seen, "delegate_tedi", input.payload.delegateToTediId);
	pushEvidenceRef(refs, seen, "tool_call", input.payload.toolCallId);
	pushEvidenceRef(refs, seen, "trace_bundle", input.payload.traceBundleId);
	pushEvidenceRef(refs, seen, "browser_session", input.payload.sessionId);
	pushEvidenceRef(refs, seen, "work_item", input.payload.workItemId);
	const workOrder = recordFrom(input.payload.workOrder);
	pushEvidenceRef(refs, seen, "runtime_run", workOrder?.runId);
	pushEvidenceRef(refs, seen, "trace_bundle", workOrder?.traceBundleId);
	return refs;
}

const BROWSER_TAKEOVER_REASONS = new Set([
	"login",
	"mfa",
	"captcha",
	"consent",
	"operator_takeover",
]);

function safeLiveViewUrl(value: unknown): string | null {
	const raw = stringFrom(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.hostname === "live.browser.run"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function safePageOrigin(value: unknown): string | null {
	const raw = stringFrom(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

function browserTakeoverInteraction(
	payload: Record<string, unknown>,
): RuntimeBrowserTakeoverInteraction | null {
	if (stringFrom(payload.kind) !== "browser_live_view_takeover") return null;
	const sessionId = stringFrom(payload.sessionId);
	const reason = stringFrom(payload.reason);
	const urlExpiresAt = stringFrom(payload.urlExpiresAt);
	if (
		!sessionId ||
		!reason ||
		!BROWSER_TAKEOVER_REASONS.has(reason) ||
		!urlExpiresAt ||
		parseRuntimeApprovalTimestamp(urlExpiresAt) === null
	) {
		return null;
	}
	const targets = Array.isArray(payload.targets)
		? payload.targets.flatMap((value) => {
				const target = recordFrom(value);
				const targetId = stringFrom(target?.targetId);
				const url = safeLiveViewUrl(target?.url);
				if (!targetId || !url) return [];
				return [
					{
						targetId,
						url,
						pageUrl: safePageOrigin(target?.pageUrl),
						title: stringFrom(target?.title),
					},
				];
			})
		: [];
	if (targets.length === 0) return null;
	return {
		type: "browser_takeover",
		reason: reason as RuntimeBrowserTakeoverInteraction["reason"],
		sessionId,
		mode: "tab",
		targets,
		urlExpiresAt,
	};
}

function approvalReviewOutcome(input: {
	status: string;
	timeout: RuntimeApprovalTimeoutDecision;
}): RuntimeApprovalReviewOutcome | null {
	if (input.timeout.expired) return "expired";
	if (
		input.status === "approved" ||
		input.status === "rejected" ||
		input.status === "cancelled" ||
		input.status === "expired"
	) {
		return input.status;
	}
	return null;
}

export function runtimeApprovalReviewSemantics(input: {
	actionType: string;
	description?: string | null;
	expiresAt?: string | null;
	id: string;
	payload?: Record<string, unknown> | null;
	status: string;
	tediId?: string;
	workflowId?: string | null;
	now?: number | Date;
}): RuntimeApprovalReviewSemantics {
	const payload = input.payload ?? {};
	const timeout = resolveRuntimeApprovalTimeout({
		status: input.status,
		expiresAt: input.expiresAt,
		now: input.now,
	});
	const intent = detectApprovalReviewIntent({
		actionType: input.actionType,
		payload,
	});
	const outcome = approvalReviewOutcome({ status: input.status, timeout });
	const state =
		input.status === "pending" && !timeout.expired
			? "requires_decision"
			: timeout.expired ||
				  input.status === "cancelled" ||
				  input.status === "expired"
				? "closed"
				: outcome
					? "resolved"
					: "closed";
	const summary =
		stringFrom(input.description) ??
		stringFrom(payload.requestPreview) ??
		stringFrom(payload.title) ??
		stringFrom(payload.name) ??
		input.actionType;
	return {
		intent,
		state,
		decisionMode:
			state === "requires_decision" ? "approve_or_reject" : "no_action",
		outcome,
		safetyDefault: "deny_on_timeout",
		summary: boundedText(summary),
		operatorQuestion:
			input.actionType === "payment_budget_override"
				? "Have you raised the matching Payments budget policy? Approving this request alone does not authorize spend."
				: approvalReviewQuestion(intent),
		timeout,
		evidenceRefs: approvalReviewEvidenceRefs({
			id: input.id,
			payload,
			tediId: input.tediId,
			workflowId: input.workflowId,
		}),
		interaction: browserTakeoverInteraction(payload),
	};
}
