import {
	createLogger,
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";
import type { GroundingPolicyVerdictCode, JudgeStats } from "./evidence-core";

type ControlAction =
	| "pause"
	| "resume"
	| "restart"
	| "restart_receipt"
	| "cancel"
	| "approve"
	| "reject"
	| "event";

type RuntimeFailureEvent =
	| "workflow.admission_dedup_prune.failed"
	| "workflow.admission_rate_limiter.failed"
	| "workflow.status_confirmation.failed"
	| "workflow.approval_status_confirmation.failed"
	| "workflow.reconciler_tick.failed"
	| "workflow.reconciliation_row.failed"
	| "workflow.reconciliation_cursor.failed"
	| "workflow.skill_usage_stamp.failed"
	| "workflow.dispatch_rationale_reconciliation.failed";

type RuntimeWarningEvent =
	| "workflow.reconciliation_status_unrecognized"
	| "artifact.immutable_divergence"
	| "reason.exchange_seal_failed"
	| "rationale.api_binding_missing"
	| "mcp_bridge.tool_list_fallback_failed"
	| "factory.capability_parser_drift"
	| "workflow.engine_status_unrecognized"
	| "evidence.judge_span_rejected"
	| "evidence.grounding_policy_warning";

type ContentFreeException = {
	name: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
};

type ControlLogFields = {
	runId: string;
	failure: ContentFreeException;
};

type FactoryLogFields = ControlLogFields & {
	service: "skill-runtime";
	kind: "started" | "failed";
	executionEpoch: number;
	attempt: number;
};

type EvidenceLogFields = {
	service: "skill-runtime";
	runId: string;
	failure?: ContentFreeException;
	failures?: ContentFreeException[];
	judge?: string;
	promptVersion?: string;
} & Partial<JudgeStats>;

type RuntimeWarningFields = {
	service: "skill-runtime";
	runId: string;
	skillId: string;
	judge: string;
	promptVersion: string;
	policyCode: GroundingPolicyVerdictCode;
	failure: ContentFreeException;
	spanRejected: number;
	resolved: number;
	causalGroundingScore: number | null;
	minCausalScore: number;
};

type EvidenceSummaryEvent =
	| "evidence.entailment_judge_dead"
	| "evidence.entailment"
	| "evidence.calibration_judge_dead"
	| "evidence.calibrated";

const safeExceptionNames = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"DOMException",
	"NullThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
	"stringThrown",
	"numberThrown",
	"booleanThrown",
	"undefinedThrown",
]);

const logger = createLogger<ControlLogFields>({
	component: "skill-runtime.control",
});

const factoryLogger = createLogger<FactoryLogFields>({
	component: "skill-runtime.factory",
	service: "skill-runtime",
});

const evidenceLogger = createLogger<EvidenceLogFields>({
	component: "skill-runtime.evidence",
	service: "skill-runtime",
});

const warningLogger = createLogger<RuntimeWarningFields>({
	component: "skill-runtime.warning",
	service: "skill-runtime",
});

function contentFreeException(error: unknown): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: safeExceptionNames.has(exception.type) ? exception.type : "Error",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(redact) }),
	});
	return redact(serializeException(error));
}

export function describeEvidenceFailure(error: unknown): ContentFreeException {
	return contentFreeException(error);
}

/** Warning context is deliberately limited to identifiers, counts and cause types. */
export function logSkillRuntimeWarning(
	event: RuntimeWarningEvent,
	context: {
		runId?: string;
		skillId?: string;
		judge?: string;
		promptVersion?: string;
		policyCode?: GroundingPolicyVerdictCode;
		caught?: unknown;
		spanRejected?: number;
		resolved?: number;
		causalGroundingScore?: number | null;
		minCausalScore?: number;
	} = {},
): void {
	const { caught, ...fields } = context;
	warningLogger.warn("Skill runtime diagnostic", {
		event,
		...fields,
		...(Object.hasOwn(context, "caught") && {
			failure: contentFreeException(caught),
		}),
	});
}

/** Evidence errors may include source URLs, claims, prompts, or credentials. */
export function logEvidenceFailure(
	event: "evidence.judge_exchange_seal_failed" | "evidence.scrape_failed",
	error: unknown,
	runId: string,
): void {
	evidenceLogger.warn("Evidence operation failed", {
		event,
		runId,
		failure: contentFreeException(error),
	});
}

export function logEvidenceJudgeSummary(
	event: EvidenceSummaryEvent,
	context: {
		runId: string;
		judge: string;
		promptVersion: string;
		stats: JudgeStats;
		failures: ContentFreeException[];
	},
): void {
	const fields = {
		event,
		runId: context.runId,
		judge: context.judge,
		promptVersion: context.promptVersion,
		...context.stats,
		...(context.failures.length > 0 && { failures: context.failures }),
	};
	if (event.endsWith("_dead")) {
		evidenceLogger.error("Evidence judge unavailable", fields);
	} else {
		evidenceLogger.info("Evidence judge completed", fields);
	}
}

/** A control failure can contain event payloads or provider credentials. */
export function logControlFailure(
	action: ControlAction,
	error: unknown,
	runId?: string,
): void {
	logger.error(`Workflow ${action} failed`, {
		event: `workflow.${action}.failed`,
		...(runId && { runId }),
		failure: contentFreeException(error),
	});
}

/** Operational failures may include request payloads or provider credentials. */
export function logRuntimeFailure(
	event: RuntimeFailureEvent,
	error: unknown,
	runId?: string,
): void {
	logger.error("Workflow runtime operation failed", {
		event,
		...(runId && { runId }),
		failure: contentFreeException(error),
	});
}

/** Factory errors can contain skill source, request payloads, or credentials. */
export function logFactoryEvidenceRetry(
	kind: "started" | "failed",
	error: unknown,
	context: { runId?: string; executionEpoch: number; attempt: number },
): void {
	factoryLogger.warn("Workflow evidence retry", {
		event: "factory.evidence_retry",
		kind,
		...(context.runId && { runId: context.runId }),
		executionEpoch: context.executionEpoch,
		attempt: context.attempt,
		failure: contentFreeException(error),
	});
}

export function logFactoryFailure(error: unknown, runId?: string): void {
	factoryLogger.error("Workflow factory failed", {
		event: "factory.failed",
		...(runId && { runId }),
		failure: contentFreeException(error),
	});
}
