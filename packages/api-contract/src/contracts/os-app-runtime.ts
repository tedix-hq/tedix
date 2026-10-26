import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";
import {
	OsAppDraftContentSchema,
	OsGadgetResourceGrantSchema,
	OsCollaborationProposalSchema,
	OsOutputContentSchema,
} from "../schemas/os-workspaces";
import {
	AppRuntimeScopeSchema,
	AppRuntimeMethodSchema,
	AppRuntimeArgumentsSchema,
	AppRuntimeSessionResultSchema,
	AppRuntimeOperationSchema,
} from "../schemas/os-app-runtime";

export const osAppRuntimeContract = oc
	.route({ tags: ["os-app-runtime"], prefix: "/os-app-runtime" })
	.errors(baseErrors)
	.router({
		client: oc
			.route({
				method: "POST",
				path: "/client",
				summary: "Read the opened app's browser client",
			})
			.input(AppRuntimeScopeSchema.strict())
			.output(
				AppRuntimeSessionResultSchema.extend({
					client: z.string(),
					revision: z.number().int().positive(),
					settings: z.record(z.string(), JsonValueSchema),
					grants: z.array(OsGadgetResourceGrantSchema),
				}),
			),
		readOutput: oc
			.route({
				method: "POST",
				path: "/read-output",
				summary: "Read an Output through an opened app slot",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					session: z.string().min(1).max(16000),
					slot: z.string().min(1).max(160),
				}).strict(),
			)
			.output(OsOutputContentSchema),
		open: oc
			.route({
				method: "POST",
				path: "/open",
				summary: "Open the deployed workspace app",
			})
			.input(AppRuntimeScopeSchema.strict())
			.output(AppRuntimeSessionResultSchema),
		call: oc
			.route({
				method: "POST",
				path: "/call",
				summary: "Call a workspace app with a scoped session",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					session: z.string().min(1).max(16000),
					method: AppRuntimeMethodSchema,
					args: AppRuntimeArgumentsSchema.default([]),
				}).strict(),
			)
			.output(z.object({ result: JsonValueSchema })),
		draft: oc
			.route({
				method: "POST",
				path: "/draft",
				summary: "Open a proposal in an isolated app facet",
			})
			.input(AppRuntimeScopeSchema.extend({ proposalId: z.uuid() }).strict())
			.output(AppRuntimeSessionResultSchema),
		saveDraft: oc
			.route({
				method: "POST",
				path: "/save-draft",
				summary: "Save Code edits or resolved app draft files for review",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					expectedRevisionId: z.uuid(),
					content: OsAppDraftContentSchema,
					proposalId: z.uuid().optional(),
					expectedSequence: z.number().int().nonnegative().optional(),
				}).strict(),
			)
			.output(z.object({ proposal: OsCollaborationProposalSchema })),
		mergeDraft: oc
			.route({
				method: "POST",
				path: "/merge-draft",
				summary: "Compare a draft with its base and the latest app revision",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					proposalId: z.uuid(),
					expectedSequence: z.number().int().nonnegative(),
				}).strict(),
			)
			.output(
				z.object({
					revisionId: z.uuid(),
					manifest: z.string(),
					files: z.record(z.string(), z.string()),
					conflicts: z.array(z.string()),
				}),
			),
		proposeEdit: oc
			.route({
				method: "POST",
				path: "/propose-edit",
				summary:
					"Read current app files and propose exact replacements from workspace Home",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					conversationId: z.string().min(1).max(200),
					expectedRevisionId: z.uuid(),
					edits: z
						.array(
							z
								.object({
									path: z
										.string()
										.min(1)
										.describe("App file to change, such as client.js"),
									before: z
										.string()
										.min(1)
										.describe(
											"Exact current text; must occur once in the file",
										),
									after: z.string().describe("Replacement text"),
								})
								.strict(),
						)
						.min(1)
						.max(24)
						.describe("Exact text replacements, applied in order"),
				}).strict(),
			)
			.output(z.object({ proposal: OsCollaborationProposalSchema })),
		preview: oc
			.route({
				method: "POST",
				path: "/preview",
				summary: "Open an isolated preview of an app revision",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					revisionId: z.uuid(),
					previewId: z.uuid(),
				}).strict(),
			)
			.output(AppRuntimeSessionResultSchema),
		capability: oc
			.route({
				method: "POST",
				path: "/capability",
				tags: ["internal"],
				summary: "Invoke a signed app resource capability",
			})
			.input(
				z
					.object({
						session: z.string().max(16000),
						operation: AppRuntimeOperationSchema,
						slot: z.string().min(1).max(160),
						args: JsonValueSchema,
					})
					.strict(),
			)
			.output(JsonValueSchema),
		recordTail: oc
			.route({
				method: "POST",
				path: "/tail",
				tags: ["internal"],
				summary: "Record an app trace in the gadget execution ledger",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					organizationId: z.string().min(1),
					tailId: z.uuid(),
					callId: z.uuid().optional(),
					revisionId: z.uuid(),
					events: z.array(JsonValueSchema).max(10),
				}).strict(),
			)
			.output(z.object({ recorded: z.boolean() })),
	});
