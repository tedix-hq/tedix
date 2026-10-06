import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	AdvanceTenantBehavioralEvalRunInputSchema,
	CreateTenantBehavioralEvalInputSchema,
	GetTenantBehavioralEvalInputSchema,
	GetTenantBehavioralEvalRunInputSchema,
	ListTenantBehavioralEvalsInputSchema,
	ListTenantBehavioralEvalRunsInputSchema,
	ReviseTenantBehavioralEvalInputSchema,
	StartTenantBehavioralEvalRunInputSchema,
	TenantBehavioralEvalDefinitionSchema,
	TenantBehavioralEvalRevisionSchema,
	TenantBehavioralEvalRunDetailSchema,
	TenantBehavioralEvalRunSchema,
} from "../schemas/tenant-behavioral-evals";

export const tenantBehavioralEvalsContract = oc
	.route({
		tags: ["tenant-behavioral-evals"],
		prefix: "/tenantBehavioralEvals",
	})
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "/definitions",
				summary: "Create an immutable tenant behavioral evaluation revision",
			})
			.input(CreateTenantBehavioralEvalInputSchema)
			.output(
				TenantBehavioralEvalDefinitionSchema.extend({
					revision: TenantBehavioralEvalRevisionSchema,
				}),
			),
		revise: oc
			.route({
				method: "POST",
				path: "/definitions/{definitionId}/revisions",
				summary: "Append an immutable evaluation revision",
			})
			.input(ReviseTenantBehavioralEvalInputSchema)
			.output(TenantBehavioralEvalRevisionSchema),
		get: oc
			.route({
				method: "GET",
				path: "/definitions/{definitionId}",
				summary: "Get an evaluation definition",
			})
			.input(GetTenantBehavioralEvalInputSchema)
			.output(
				TenantBehavioralEvalDefinitionSchema.extend({
					revisions: TenantBehavioralEvalRevisionSchema.array(),
				}),
			),
		list: oc
			.route({
				method: "GET",
				path: "/definitions",
				summary: "List tenant evaluation definitions",
			})
			.input(ListTenantBehavioralEvalsInputSchema)
			.output(TenantBehavioralEvalDefinitionSchema.array()),
		startRun: oc
			.route({
				method: "POST",
				path: "/runs",
				summary: "Start a pinned diagnostic evaluation run",
			})
			.input(StartTenantBehavioralEvalRunInputSchema)
			.output(TenantBehavioralEvalRunSchema),
		advanceRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/advance",
				summary: "Advance one bounded evaluation step",
			})
			.input(AdvanceTenantBehavioralEvalRunInputSchema)
			.output(TenantBehavioralEvalRunDetailSchema),
		getRun: oc
			.route({
				method: "GET",
				path: "/runs/{runId}",
				summary: "Read a tenant evaluation run",
			})
			.input(GetTenantBehavioralEvalRunInputSchema)
			.output(TenantBehavioralEvalRunDetailSchema),
		listRuns: oc
			.route({
				method: "GET",
				path: "/runs",
				summary: "List tenant evaluation runs",
			})
			.input(ListTenantBehavioralEvalRunsInputSchema)
			.output(TenantBehavioralEvalRunSchema.array()),
	});
