import * as z from "zod";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { encodeWorkflowArtifactPathSegment } from "./workflow-path";

export const RationaleEventSchema = z.object({
	gate: z.enum([
		"workflow_dispatch",
		"wait_for_event_pause",
		"wait_for_event_resume",
		"step_do_failure",
	]),
	stepName: z.string().optional(),
	stepCount: z.number().int().min(1).optional(),
	attempt: z.number().int().min(1).optional(),
	retryable: z.boolean().optional(),
	eventType: z.string().optional(),
	timeout: z.unknown().optional(),
	payload: z.unknown().optional(),
	error: z
		.object({
			message: z.string(),
			name: z.string().optional(),
			code: z.string().optional(),
		})
		.optional(),
	durationMs: z.number().optional(),
});

const RationaleRecordSchema = RationaleEventSchema.extend({
	runId: z.string().min(1),
	skillId: z.string().min(1),
	tediId: z.string().min(1),
	orgId: z.string().min(1),
	skillSlug: z.string().nullable().optional(),
});

export type RationaleRecordInput = z.infer<typeof RationaleRecordSchema>;

export async function workflowRationaleIdempotencyKey(input: {
	runId: string;
	executionEpoch: number;
	gate: z.infer<typeof RationaleEventSchema>["gate"];
	stepName?: string;
	stepCount?: number;
	attempt?: number;
}): Promise<string> {
	const semanticGate = JSON.stringify([
		input.runId,
		input.executionEpoch,
		input.gate,
		input.stepName ?? null,
		input.stepCount ?? null,
		input.gate === "step_do_failure" ? (input.attempt ?? null) : null,
	]);
	const hex = await sha256Hex(semanticGate);
	return `skill-workflow-rationale:${hex}`;
}

interface BuiltRationale {
	action: string;
	rationale: string;
	category: "optimization";
	confidence: number;
	outcomeStatus?: "success" | "failure" | "partial";
	outcome?: string;
	evidence: Record<string, unknown>;
}

export function buildWorkflowRationalePayload(
	parsed: RationaleRecordInput,
): BuiltRationale {
	const slug = parsed.skillSlug ?? parsed.skillId;
	const baseEvidence = {
		kind: "skill_workflow_step",
		skillId: parsed.skillId,
		skillSlug: parsed.skillSlug ?? null,
		runId: parsed.runId,
		runUri: `skill://runs/${parsed.runId}`,
		stepName: parsed.stepName ?? null,
		stepCount: parsed.stepCount ?? null,
	};

	switch (parsed.gate) {
		case "wait_for_event_pause":
			return {
				action: `Skill workflow pausing for event: ${parsed.eventType ?? "unknown"}`,
				rationale: `Workflow ${slug} run ${parsed.runId} hibernated at step "${parsed.stepName ?? "?"}" awaiting event "${parsed.eventType ?? "?"}". Will resume when send_skill_workflow_event delivers a matching event.`,
				category: "optimization",
				confidence: 0.9,
				// Long-lived gate — leave open until resumed. The resume
				// emits its own success record rather than completing this
				// one, so each gate stays atomic in the timeline.
				outcomeStatus: undefined,
				evidence: {
					...baseEvidence,
					eventType: parsed.eventType ?? null,
					timeout: parsed.timeout ?? null,
				},
			};
		case "wait_for_event_resume":
			return {
				action: `Skill workflow resumed from event: ${parsed.eventType ?? "unknown"}`,
				rationale: `Workflow ${slug} run ${parsed.runId} resumed at step "${parsed.stepName ?? "?"}" after receiving "${parsed.eventType ?? "?"}".`,
				category: "optimization",
				confidence: 0.9,
				outcomeStatus: "success",
				outcome: "Event received; workflow continued.",
				evidence: {
					...baseEvidence,
					eventType: parsed.eventType ?? null,
					eventPayload: parsed.payload ?? null,
				},
			};
		case "step_do_failure": {
			const errorArtifactUri =
				parsed.stepName && parsed.skillSlug
					? `skill://${parsed.skillSlug}/runs/${parsed.runId}/outputs/${encodeWorkflowArtifactPathSegment(parsed.stepName)}.error.json`
					: null;
			return {
				action: `Skill workflow step failed: ${parsed.stepName ?? "?"}`,
				rationale: `step.do("${parsed.stepName ?? "?"}") in workflow ${slug} run ${parsed.runId} failed after retries. Error attributed to the skill body or its declared dependencies.`,
				category: "optimization",
				confidence: 0.85,
				outcomeStatus: "failure",
				outcome: parsed.error?.message ?? "Step failed",
				evidence: {
					...baseEvidence,
					error: parsed.error ?? null,
					durationMs: parsed.durationMs ?? null,
					attempt: parsed.attempt ?? null,
					retryable: parsed.retryable ?? null,
					errorArtifactUri,
					blameChain: [
						{
							component: "skill",
							id: parsed.skillId,
							contribution: "high",
							reason: parsed.error?.message ?? "step.do failure",
						},
					],
				},
			};
		}
		case "workflow_dispatch":
			return {
				action: `Skill workflow dispatched: ${slug}`,
				rationale: `Started workflow ${slug} run ${parsed.runId} for tedi ${parsed.tediId}. Run-pinned source ensures the workflow loads exactly the code at dispatch time across hibernations (G0).`,
				category: "optimization",
				confidence: 0.9,
				outcomeStatus: "success",
				outcome: `Workflow run ${parsed.runId} created.`,
				evidence: { ...baseEvidence },
			};
	}
}
