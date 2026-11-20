/**
 * Contracts for any agent runtime that calls tools or data. Every call
 * passes the same three adapters (memory, accountability, compliance), so
 * one call produces one decision and one ledger row whichever runtime
 * carried it. Tedix's workspace object and its MCP gateway are two
 * consumers; neither defines the contract.
 *
 * This package is runtime-neutral: plain TypeScript with no platform,
 * database or application imports. The vocabulary (`riskTier`,
 * `blastRadius`, `gate`, `disposition`, `needs_approval`) is the one the
 * consumers already audit and decide with.
 */

/** Operational enforcement tier of a tool or binding method. */
export const RISK_TIERS = [
	"read",
	"bounded_write",
	"high_impact_write",
	"external_side_effect",
] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Maximum side-effect boundary of one call. */
export const BLAST_RADII = [
	"none",
	"single_resource",
	"tenant",
	"multi_tenant",
	"external_system",
] as const;
export type BlastRadius = (typeof BLAST_RADII)[number];

/** What a tenant policy rule says about a call before any approval. */
export type PolicyDisposition = "allow" | "ask" | "deny";

/** The gate that decided; the same names the gateway writes into audit rows. */
export type ComplianceGate =
	| "edge_access"
	| "tool_scope"
	| "risk_rate_limit"
	| "annotation_assertion"
	| "destructive_approval"
	| "secret_egress"
	| "budget";

/** The verdict a caller acts on. */
export type ComplianceVerdict = "allow" | "needs_approval" | "deny";

/** Who performed or requested an action. */
export interface Actor {
	/** Stable id of the person, agent, service or session acting. */
	id: string;
	/** Open union: runtimes may add their own kinds (Tedix uses `tedi`). */
	kind: "user" | "agent" | "service" | "system" | (string & {});
	/** Organization the actor acted in. */
	organizationId?: string;
}

/** Where a value or action came from: the enforcement point and request that carried it. */
export interface Source {
	/**
	 * Free string naming the enforcement point. Examples: `mcp_gateway`,
	 * `mcp_codemode`, `mcp_widget`, `workspace_object`, `migration`,
	 * `cli`, `cron`.
	 */
	surface: string;
	/** Request, run or trace id for correlation. */
	traceId?: string;
}

/** One call about to be made through a binding. */
export interface CallDescription {
	/** Resource the call touches: `tool:<id>`, `memory:<key>`, `output:<id>`. */
	resource: string;
	/** Method or tool name. */
	operation: string;
	/** Arguments as the caller sent them; never mutated by adapters. */
	args: unknown;
	actor: Actor;
	source: Source;
	riskTier?: RiskTier;
	blastRadius?: BlastRadius;
	/** The call destroys or irreversibly changes existing data. */
	destructive?: boolean;
	/** Approval receipt the caller carries, when it has one. */
	approvalRequestId?: string;
	/** Free-form, approver-facing title. */
	title?: string;
}

/** Spend window of one risk tier for one actor. */
export interface BudgetState {
	limit: number;
	windowSeconds: number;
	/** Calls already made in the window, when the limiter reports it. */
	used?: number;
	remaining?: number;
}

/** Result of the per-call limiter. */
export interface RateState {
	limited: boolean;
	retryAfterSeconds?: number;
	/** Keying scope of the limiter, e.g. `organization_caller_app_tool`. */
	scope?: string;
}

export interface ComplianceDecision {
	verdict: ComplianceVerdict;
	/** The gate that produced the verdict. `allow` names the last gate passed. */
	gate: ComplianceGate;
	/** Short machine-readable reason, the same string the gateway audits. */
	reason: string;
	riskTier: RiskTier | "unclassified";
	blastRadius: BlastRadius | "unclassified";
	budget?: BudgetState;
	rate?: RateState;
	/** Who may decide a `needs_approval` hold. */
	approvalRoute?: "human" | "agent";
}

/** What happened after a call was allowed and executed. */
export type CallOutcome =
	| { status: "applied"; result?: unknown; durationMs?: number }
	| { status: "not_applied"; error: string; durationMs?: number }
	| { status: "unknown"; error: string; durationMs?: number };

export interface ComplianceAdapter {
	/** Decide before any tool or binding call. Never throws for a policy reason. */
	check(call: CallDescription): Promise<ComplianceDecision>;
	/** Record what the call did after it ran, or that it did not run. */
	record(
		call: CallDescription,
		decision: ComplianceDecision,
		outcome: CallOutcome,
	): Promise<void>;
}

/** A revision pointer: a revision id and, when known, a content hash. */
export interface RevisionRef {
	revisionId: string;
	hash?: string;
}

/**
 * Which approval path let a call through. One name per path of the runtime
 * that recorded it:
 *
 * - `owner_request`: an owner or admin approved a parked request for this exact call.
 * - `self_authorized`: an owner or admin called the tool directly; the call is the decision.
 * - `home_request`: a person approved the write in a Home run's approval tray.
 * - `machine_request`: an owner or admin approved a parked machine-session request.
 * - `durable_grant`: a standing `once` or `always` grant for this caller and tool.
 * - `work_item_authorization`: an authorization receipt on the caller's Work Item.
 * - `self_confirmation`: the caller confirmed in its own arguments, with a reason.
 * - `elicitation`: the caller answered an approval request (input round trip).
 * - `policy`: an automatic rule approved it; no person was asked.
 * - `legacy_agent_confirmation`: an agent's own confirmation of a bounded write.
 * - `skill_manifest`: the pinned manifest of the running skill declares the call.
 * - `owner_skill_start`: an owner or admin started an active skill.
 * - `own_home_run`: the caller stopped their own Home run.
 * - `attempt_lifecycle`: an admitted Work Attempt's own lifecycle write.
 */
export type ApprovalKind =
	| "owner_request"
	| "self_authorized"
	| "home_request"
	| "machine_request"
	| "durable_grant"
	| "work_item_authorization"
	| "self_confirmation"
	| "elicitation"
	| "policy"
	| "legacy_agent_confirmation"
	| "skill_manifest"
	| "owner_skill_start"
	| "own_home_run"
	| "attempt_lifecycle";

/** Longest approver or caller reason kept in approval evidence. */
export const APPROVAL_REASON_MAX_LENGTH = 500;

/** Policy identifiers an approval path had when it decided. */
export interface ApprovalPolicyRef {
	revisionId?: string;
	ruleDigest?: string;
	descriptorDigest?: string;
	/** Digest of the tool's configuration the approval was requested against. */
	configHash?: string;
	/** Rule, grant or receipt id that decided. */
	ruleId?: string;
}

/** Who approved a call, through which path, and what they were shown. */
export interface ApprovalEvidence {
	/**
	 * The approving person's id. For self paths, the caller. For paths with no
	 * human approver at decision time, a `<kind>:<id>` reference to the
	 * authority that decided, such as `policy:<rule>` or `grant:<id>`.
	 */
	approverId: string;
	approvedAt: string;
	/**
	 * SHA-256 hex of what the approver was shown. Absent when nobody was shown
	 * anything (grants, policies, self paths).
	 */
	presentedHash?: string;
	/** The approval request this evidence settles. */
	approvalRequestId?: string;
	kind?: ApprovalKind;
	/**
	 * `hashValue` of the arguments the approval was tied to, computed the same
	 * way as `ChangeRecord.argsHash`, so equal values mean the approval covered
	 * exactly the recorded arguments. Absent when the path does not bind
	 * arguments.
	 */
	boundArgsHash?: string;
	/** The approval was consumed by this call and cannot be used again. */
	singleUse?: boolean;
	policy?: ApprovalPolicyRef;
	/** Reason given by the approver or caller, at most `APPROVAL_REASON_MAX_LENGTH` characters. */
	reason?: string;
}

/** How to undo the change. Absent when the change is not reversible. */
export interface UndoPlan {
	/** `rollback_revision`, `compensating_call`, `manual`. */
	kind: "rollback_revision" | "compensating_call" | "manual";
	/** For `rollback_revision`: the revision to restore. */
	toRevision?: RevisionRef;
	/** For `compensating_call`: the call that reverses the effect. */
	call?: Pick<CallDescription, "resource" | "operation" | "args">;
	/** For `manual`: what a person must do. */
	instructions?: string;
}

/**
 * Layout version of a change record. Absent means 1. Version 2 added
 * `environment` and `parent`. Every version hashes the same way
 * (`recordDigest` in `./seal`): absent fields are dropped before hashing, so
 * a sealed version 1 record keeps its digest and still verifies.
 */
export const CHANGE_RECORD_SCHEMA_VERSION = 2;

/** What ran the call, as far as the recorder can tell. Every field is optional. */
export interface ChangeEnvironment {
	/** Git commit of the code that recorded the call. */
	productSha?: string;
	/** Deployed version id of the Worker or service that recorded it. */
	workerVersionId?: string;
	/** Agent harness that made the call, e.g. `claude-code`, `codex`, `tedi`. */
	harness?: string;
	harnessVersion?: string;
	/** Model that decided to make the call, as `<provider>/<model>` when known. */
	model?: string;
	/**
	 * `hashValue` of the policy inputs the compliance decision used for this
	 * call (for the gateway: the tool's risk policy, annotations and write
	 * capability), so two records with equal digests were judged by the same rules.
	 */
	policyDigest?: string;
}

/** Where the call sits in a run tree. */
export interface ChangeParent {
	/** The run (agent turn, skill run, kernel request) that made the call. */
	runId?: string;
	/** The run at the root of the tree, when it differs from `runId`. */
	rootRunId?: string;
	/** Another change record this call follows from. */
	recordId?: string;
}

/** One row in the accountability ledger. Append-only; never edited. */
export interface ChangeRecord {
	/** `CHANGE_RECORD_SCHEMA_VERSION` when written; absent on version 1 records. */
	schemaVersion?: number;
	id: string;
	/** Monotonic position in the ledger. */
	sequence: number;
	recordedAt: string;
	resource: string;
	operation: string;
	actor: Actor;
	source: Source;
	before?: RevisionRef;
	after?: RevisionRef;
	decision: ComplianceDecision;
	outcome: CallOutcome["status"] | "denied" | "needs_approval";
	approval?: ApprovalEvidence;
	undo?: UndoPlan;
	/** Hash of the call arguments, so the row can be matched without storing secrets. */
	argsHash: string;
	/** The task the call was about, when known. */
	subject?: { kind: "work_item"; id: string };
	environment?: ChangeEnvironment;
	parent?: ChangeParent;
}

export type ChangeRecordInput = Omit<
	ChangeRecord,
	"id" | "sequence" | "recordedAt"
>;

export interface LedgerQuery {
	resource?: string;
	actorId?: string;
	/** Only rows after this sequence. */
	afterSequence?: number;
	limit?: number;
}

export interface AccountabilityAdapter {
	/** Append one record and return it with its id and sequence. */
	append(record: ChangeRecordInput): Promise<ChangeRecord>;
	list(query?: LedgerQuery): Promise<ChangeRecord[]>;
	get(id: string): Promise<ChangeRecord | null>;
	/** Every row, oldest first, as a portable JSON document. */
	export(): Promise<{ exportedAt: string; records: ChangeRecord[] }>;
}

export type MemoryReviewState = "pending" | "approved" | "rejected";

/** Provenance of one memory revision. */
export interface MemoryProvenance {
	actor: Actor;
	source: Source;
	/** Ledger row that recorded this write. */
	changeRecordId?: string;
}

export interface MemoryRevision {
	revisionId: string;
	key: string;
	/** Revision number within the key, starting at 1. */
	revision: number;
	value: unknown;
	hash: string;
	writtenAt: string;
	provenance: MemoryProvenance;
	review: MemoryReviewState;
	reviewedBy?: string;
	reviewedAt?: string;
	reviewNote?: string;
	/** Set when this revision was written by a rollback to an earlier one. */
	rolledBackFrom?: string;
}

export interface MemoryEntry {
	key: string;
	/** Newest revision, whatever its review state. */
	current: MemoryRevision;
	/** Newest approved revision, when one exists. */
	approved?: MemoryRevision;
}

export interface MemoryWriteInput {
	key: string;
	value: unknown;
	provenance: MemoryProvenance;
	/** Writes land as `pending` unless the writer marks them approved. */
	review?: MemoryReviewState;
}

export interface MemoryAdapter {
	write(input: MemoryWriteInput): Promise<MemoryRevision>;
	read(key: string): Promise<MemoryEntry | null>;
	list(prefix?: string): Promise<MemoryEntry[]>;
	/** Revisions of one key, oldest first. */
	history(key: string): Promise<MemoryRevision[]>;
	review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	): Promise<MemoryRevision>;
	/** Write a new revision whose value is a prior revision's value. */
	rollback(
		key: string,
		toRevisionId: string,
		provenance: MemoryProvenance,
	): Promise<MemoryRevision>;
}

export interface GovernanceAdapters {
	memory: MemoryAdapter;
	accountability: AccountabilityAdapter;
	compliance: ComplianceAdapter;
}
