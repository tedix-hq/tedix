/**
 * Kernel — multi-tedi plan helpers: render the work order one owner receives
 * for an approved plan assignment.
 */

import type { HomePlan } from "@tedix/api-contract/schemas/kernel-runtime";

export function previewPlanContent(content: string): string {
	const trimmed = content.trim().replace(/\s+/g, " ");
	return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

export const HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS = [
	"Assignment scope is authoritative: execute and report only the objective above.",
	"The original Home request is supporting context for facts, identifiers, and constraints, but sibling assignments remain out of scope.",
	"Do not perform, summarize, or claim completion of another owner's objective; Home will synthesize the branches.",
].join(" ");

export function homePlanAssignmentDispatchContent(input: {
	assignment: HomePlan["assignments"][number];
	homeRunId: string;
	plan: HomePlan;
	sourceRequest?: string | null;
	workItemId: string;
}): string {
	const evidence = input.assignment.expectedEvidence
		.map((item) => `- ${item}`)
		.join("\n");
	const sourceRequest = input.sourceRequest ?? "";
	return [
		`Home approved this assignment for ${input.assignment.ownerLabel}.`,
		"",
		`Objective: ${input.assignment.objective}`,
		"",
		HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS,
		...(sourceRequest
			? ["", "Original Home request (supporting context only):", sourceRequest]
			: []),
		`Work Item: ${input.workItemId}`,
		`Home plan: ${input.plan.id}`,
		`Home run: ${input.homeRunId}`,
		"",
		"Return concise evidence to Home when complete:",
		evidence || "- Result summary tied back to the Home request.",
	].join("\n");
}
