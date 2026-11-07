/**
 * Enforce check -> call -> record around every async method of a binding.
 * Any two runtimes that wrap the same call this way make identical
 * decisions and identical ledger rows for it.
 */
import { hashArguments } from "./hash";
import type {
	AccountabilityAdapter,
	Actor,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ComplianceAdapter,
	ComplianceDecision,
	RevisionRef,
	Source,
	UndoPlan,
	RiskTier,
	BlastRadius,
} from "./types";

export class CallRefusedError extends Error {
	readonly decision: ComplianceDecision;
	readonly record: ChangeRecord;
	constructor(decision: ComplianceDecision, record: ChangeRecord) {
		super(
			decision.verdict === "needs_approval"
				? `Approval required: ${decision.reason}`
				: `Call denied by ${decision.gate}: ${decision.reason}`,
		);
		this.name = "CallRefusedError";
		this.decision = decision;
		this.record = record;
	}
}

/** Describes one method of a binding so the wrapper can classify its calls. */
export interface MethodPolicy {
	resource?: string;
	riskTier?: RiskTier;
	blastRadius?: BlastRadius;
	destructive?: boolean;
	/** Capture the revision before the call so the ledger row can name it. */
	before?: (args: unknown[]) => Promise<RevisionRef | undefined>;
	/** Capture the revision after the call. */
	after?: (
		args: unknown[],
		result: unknown,
	) => Promise<RevisionRef | undefined>;
	undo?: (
		args: unknown[],
		result: unknown,
		before?: RevisionRef,
	) => UndoPlan | undefined;
}

export interface WrapBindingOptions<B extends object> {
	compliance: ComplianceAdapter;
	accountability: AccountabilityAdapter;
	actor: Actor;
	source: Source;
	/** Resource name when a method has none of its own: `tool:crm`, `memory`. */
	resource: string;
	methods?: Partial<Record<keyof B & string, MethodPolicy>>;
	/** Called after the ledger row exists, with the outcome; errors are swallowed. */
	onRecorded?: (record: ChangeRecord) => void;
}

/** Everything the wrapper does for one call, usable without a Proxy. */
export async function guardedCall<T>(
	call: CallDescription,
	execute: () => Promise<T>,
	deps: Pick<
		WrapBindingOptions<object>,
		"compliance" | "accountability" | "onRecorded"
	> & {
		before?: RevisionRef;
		prepareBefore?: () => Promise<RevisionRef | undefined>;
		after?: (result: T) => Promise<RevisionRef | undefined>;
		undo?: (result: T) => UndoPlan | undefined;
		/** Bindings that report failure in their result instead of throwing. */
		classify?: (result: T) => CallOutcome;
	},
): Promise<{ result: T; decision: ComplianceDecision; record: ChangeRecord }> {
	const started = Date.now();
	// An unavailable digest must be explicit rather than silently dropping the call.
	let argsHash = "unavailable";
	let decision: ComplianceDecision;
	let before = deps.before;
	try {
		argsHash = await hashArguments(call.args);
		decision = await deps.compliance.check(call);
		if (decision.verdict === "allow" && deps.prepareBefore) {
			before = await deps.prepareBefore();
		}
	} catch (error) {
		decision = {
			verdict: "deny",
			gate: "annotation_assertion",
			reason: `preflight_failed: ${error instanceof Error ? error.message : String(error)}`,
			riskTier: call.riskTier ?? "unclassified",
			blastRadius: call.blastRadius ?? "unclassified",
		};
	}
	let outcome: CallOutcome;
	let thrown: unknown;
	let result: T | undefined;
	let after: RevisionRef | undefined;
	let undo: UndoPlan | undefined;
	if (decision.verdict !== "allow") {
		outcome = { status: "not_applied", error: decision.reason };
	} else {
		try {
			result = await execute();
			const classified = deps.classify?.(result);
			if (classified && classified.status !== "applied") {
				outcome = { ...classified, durationMs: Date.now() - started };
			} else {
				after = await deps.after?.(result);
				undo = deps.undo?.(result);
				outcome = { status: "applied", durationMs: Date.now() - started };
			}
		} catch (error) {
			thrown = error;
			outcome = {
				status: "unknown",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started,
			};
		}
	}
	const record = await deps.accountability.append({
		resource: call.resource,
		operation: call.operation,
		actor: call.actor,
		source: call.source,
		decision,
		argsHash,
		...(before ? { before } : {}),
		...(after ? { after } : {}),
		...(undo ? { undo } : {}),
		outcome:
			decision.verdict === "allow"
				? outcome.status
				: decision.verdict === "deny"
					? "denied"
					: "needs_approval",
	});
	await deps.compliance.record(call, decision, outcome);
	try {
		deps.onRecorded?.(record);
	} catch {
		// Observers cannot change the recorded outcome.
	}
	if (decision.verdict !== "allow")
		throw new CallRefusedError(decision, record);
	if (outcome.status === "unknown") throw thrown;
	return { result: result as T, decision, record };
}

/**
 * Wrap every async method of `binding`. Each call is checked, executed, and
 * recorded; a refused call throws `CallRefusedError` with the decision and
 * ledger row and never reaches the binding.
 */
export function wrapBinding<B extends object>(
	binding: B,
	options: WrapBindingOptions<B>,
): B {
	return new Proxy(binding, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || typeof property !== "string") {
				return value;
			}
			const policy = options.methods?.[property as keyof B & string];
			return async (...args: unknown[]) => {
				const call: CallDescription = {
					resource: policy?.resource ?? options.resource,
					operation: property,
					args,
					actor: options.actor,
					source: options.source,
					...(policy?.riskTier ? { riskTier: policy.riskTier } : {}),
					...(policy?.blastRadius ? { blastRadius: policy.blastRadius } : {}),
					...(policy?.destructive ? { destructive: true } : {}),
				};
				let before: RevisionRef | undefined;
				const { result } = await guardedCall(
					call,
					() => Promise.resolve(Reflect.apply(value, target, args)),
					{
						compliance: options.compliance,
						accountability: options.accountability,
						onRecorded: options.onRecorded,
						prepareBefore: async () => {
							before = await policy?.before?.(args);
							return before;
						},
						after: policy?.after
							? (result) => policy.after!(args, result)
							: undefined,
						undo: policy?.undo
							? (result) => policy.undo!(args, result, before)
							: undefined,
					},
				);
				return result;
			};
		},
	});
}
