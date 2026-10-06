/**
 * Rationale Records Zod Schemas
 * Validation schemas for tedi decision journal endpoints
 */

import * as z from "zod";
import {
	RATIONALE_OUTCOME_STATUSES,
	RATIONALE_PROOF_REF_KINDS,
} from "../constants/enums";
import { JsonValueSchema } from "./common";

// =============================================================================
// CORE SCHEMAS
// =============================================================================

export const BlameChainEntrySchema = z.object({
	component: z.enum([
		"brain_fact",
		"directive",
		"skill",
		"graph_edge",
		"missing_skill",
	]),
	id: z.string().optional(),
	contribution: z.enum(["high", "medium", "low"]),
	reason: z.string(),
});

export type BlameChainEntry = z.infer<typeof BlameChainEntrySchema>;

/**
 * Span-checkable proof reference for an outcome claim (WS1 flywheel remodel).
 * `ref` identifies the evidence span: a runtime runId, a tool-call ref from
 * the runtime event ledger, an artifact id/URI, or a work-item id whose state
 * change evidences the outcome.
 */
export const RationaleProofRefSchema = z.object({
	kind: z.enum(RATIONALE_PROOF_REF_KINDS),
	ref: z.string().min(1).max(512),
});

export type RationaleProofRef = z.infer<typeof RationaleProofRefSchema>;

/**
 * Tool-call refs are identifiers/spans from the runtime event ledger
 * (`tedi_runtime_events`), e.g. `{runId}:step:{stepNumber}:{toolName}`.
 */
export const RationaleToolCallRefsSchema = z
	.array(z.string().min(1).max(512))
	.max(64);

export const RationaleRecordSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	orgId: z.string(),
	action: z.string(),
	rationale: z.string(),
	category: z.string(),
	confidence: z.number(),
	evidence: z.record(z.string(), JsonValueSchema),
	outcome: z.string().nullable(),
	outcomeStatus: z.enum(RATIONALE_OUTCOME_STATUSES),
	approvalRequestId: z.string().nullable(),
	objectiveId: z.string().nullable(),
	/** Execution links (WS1) — at least one is present on every new record. */
	runId: z.string().nullable(),
	workItemId: z.string().nullable(),
	toolCallRefs: z.array(z.string()).nullable(),
	/** Span-checkable proof for a `success` outcome; null until completion. */
	proofRef: RationaleProofRefSchema.nullable(),
	createdAt: z.string(),
	completedAt: z.string().nullable(),
	blameChain: z.array(BlameChainEntrySchema).nullable().optional(),
});

export type RationaleRecord = z.infer<typeof RationaleRecordSchema>;
