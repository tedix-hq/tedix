import * as z from "zod";
import { jsonSchema, zodSchema } from "ai";
import type { RouteChoice } from "./route-decision";
import {
	KernelRouteDecisionSchema,
	type KernelRouteDecision,
} from "./route-schema";
import type { KernelContext } from "./context-assembly";

export const ROUTE_DETAILS_PROMPT_VERSION = "home-route-details-v1";

/** The writer cannot change the chosen route, target, or confidence. */
export function routeDetailsSchema(choice: RouteChoice) {
	const common = KernelRouteDecisionSchema.pick({
		rationale: true,
		risk: true,
		effortClass: true,
		evidenceExpectation: true,
	});
	const shape: z.ZodType<Partial<KernelRouteDecision>> = (() => {
		switch (choice.routeKind) {
			case "answer_in_home":
				return KernelRouteDecisionSchema.pick({ answer: true });
			case "ask_human":
				return common.extend({
					clarifyingQuestion: z.string().describe("non-empty text"),
				});
			case "propose_tool_write":
				return common.extend({
					toolIntent: KernelRouteDecisionSchema.shape.toolIntent.unwrap(),
				});
			case "run_workflow":
				return common.extend({
					workflowHint: z.string().describe("non-empty text"),
				});
			case "suggest_handoff":
				return common.extend({ answer: z.string().describe("non-empty text") });
			case "delegate_tedi":
				return common.extend(
					KernelRouteDecisionSchema.pick({
						targetActivityId: true,
						plannedToolIds: true,
					}).shape,
				);
		}
	})();
	return jsonSchema<
		KernelRouteDecision & { details?: Partial<KernelRouteDecision> | null }
	>(zodSchema(shape).jsonSchema, {
		validate: (value) => {
			const parsed = shape.safeParse(value);
			if (!parsed.success) return { success: false, error: parsed.error };
			const route = KernelRouteDecisionSchema.safeParse({
				answer: null,
				rationale: "Answered from available context.",
				risk: "low",
				effortClass: "single_read",
				targetActivityId: null,
				plannedToolIds: [],
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
				...parsed.data,
				...choice,
			});
			if (!route.success) return { success: false, error: route.error };
			if (choice.routeKind === "answer_in_home" && !route.data.answer?.trim())
				return { success: false, error: new Error("Direct answer is empty") };
			const requiredText =
				choice.routeKind === "ask_human"
					? route.data.clarifyingQuestion
					: choice.routeKind === "run_workflow"
						? route.data.workflowHint
						: choice.routeKind === "propose_tool_write"
							? route.data.toolIntent?.capability
							: choice.routeKind === "suggest_handoff"
								? route.data.answer
								: null;
			if (requiredText !== null && !requiredText?.trim())
				return {
					success: false,
					error: new Error("Required route detail is empty"),
				};
			return { success: true, value: route.data };
		},
	});
}

export function routeWriterContext(
	context: KernelContext,
	choice: RouteChoice,
): KernelContext {
	const target = choice.targetTediId;
	return {
		...context,
		tedis: target
			? context.tedis.filter((tedi) => tedi.id === target)
			: context.tedis.map(({ capability: _capability, ...tedi }) => tedi),
		apps:
			choice.routeKind === "propose_tool_write"
				? context.apps
				: context.apps.map(({ slug, name }) => ({ slug, name })),
		workflows:
			choice.routeKind === "run_workflow" ||
			choice.routeKind === "answer_in_home"
				? context.workflows
				: [],
	};
}

export function routeDetailsInstruction(choice: RouteChoice): string {
	return `The route is already selected: ${choice.routeKind}${choice.targetTediId ? `; target tedi ${choice.targetTediId} (${choice.targetTediLabel})` : ""}. Write ONLY the fields in the supplied details schema. Do not choose another route or target and do not emit routeKind or confidence. Existing permission and approval checks still apply. For answer_in_home return only {"answer":"your useful answer from context"}. For other routes ground every detail in the available context; never invent a tool, activity, or workflow.`;
}
