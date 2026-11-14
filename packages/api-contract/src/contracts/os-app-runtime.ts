import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";
import {
	OsAppDraftContentSchema,
	OsGadgetRevisionSchema,
	OsGadgetResourceGrantSchema,
	OsCollaborationProposalSchema,
	OsOutputContentSchema,
} from "../schemas/os-workspaces";
import {
	AppRuntimeScopeSchema,
	AppRuntimePublicOperationsSchema,
	AppRuntimeMethodSchema,
	AppRuntimeArgumentsSchema,
	AppRuntimeSessionResultSchema,
	AppRuntimeOperationSchema,
	AppDraftRoomScopeSchema,
	AppDraftRoomSubmissionSchema,
	AppDraftRoomSnapshotSchema,
	AppDraftRoomSubmitResultSchema,
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
		listOperations: oc
			.route({
				method: "POST",
				path: "/operations",
				summary:
					"Discover a runtime app's operations, input schemas, effects and Output slots without reading code",
			})
			.input(AppRuntimeScopeSchema.strict())
			.output(
				z.object({
					revisionId: z.uuid(),
					operations: AppRuntimePublicOperationsSchema,
				}),
			),
		invokeOperation: oc
			.route({
				method: "POST",
				path: "/invoke-operation",
				summary:
					"Call a declared app operation with named input; open the app first for a scoped session",
				description:
					"Input is checked against the manifest JSON Schema and passed as the method's sole argument. Effects are author declarations; existing app grants and caller access still apply.",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					session: z.string().min(1).max(16000),
					name: AppRuntimeMethodSchema,
					input: z.record(z.string(), JsonValueSchema),
				}).strict(),
			)
			.output(z.object({ result: JsonValueSchema })),
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
		readDraftRoom: oc
			.route({
				method: "POST",
				path: "/read-draft-room",
				summary:
					"Read the shared draft code and OT position without publishing it",
			})
			.input(AppDraftRoomScopeSchema)
			.output(AppDraftRoomSnapshotSchema),
		submitDraftChange: oc
			.route({
				method: "POST",
				path: "/submit-draft-change",
				summary:
					"Submit an attributed change to the same shared draft stream people edit",
			})
			.input(
				AppDraftRoomScopeSchema.extend({
					submission: AppDraftRoomSubmissionSchema,
				}).strict(),
			)
			.output(
				z.strictObject({
					result: AppDraftRoomSubmitResultSchema,
					snapshot: AppDraftRoomSnapshotSchema,
				}),
			),
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
					conversationId: z.string().min(1).max(200).optional(),
					expectedRevisionId: z.uuid(),
					proposalId: z.uuid().optional(),
					expectedSequence: z.number().int().nonnegative().optional(),
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
			.output(
				z.object({
					proposal: OsCollaborationProposalSchema,
					previewUrl: z.string(),
				}),
			),
		acceptEdit: oc
			.route({
				method: "POST",
				path: "/accept-edit",
				summary: "Accept and publish an app draft at its reviewed sequence",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					proposalId: z.uuid(),
					expectedSequence: z.number().int().nonnegative(),
					rationale: z.string().min(1).max(4000),
				}).strict(),
			)
			.output(z.object({ revision: OsGadgetRevisionSchema })),
		revisions: oc
			.route({
				method: "POST",
				path: "/revisions",
				summary: "List earlier app revisions for restore",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					limit: z.number().int().min(1).max(100).default(20),
				}).strict(),
			)
			.output(z.object({ revisions: z.array(OsGadgetRevisionSchema) })),
		restoreRevision: oc
			.route({
				method: "POST",
				path: "/restore-revision",
				summary:
					"Restore an earlier app revision as a new version, preserving history",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					revisionId: z.uuid(),
					expectedRevisionId: z.uuid(),
				}).strict(),
			)
			.output(z.object({ revision: OsGadgetRevisionSchema })),
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
		triggerWebhook: oc
			.route({
				method: "POST",
				path: "/trigger-webhook",
				summary:
					"Get the address and signing secret of an app's webhook trigger",
				description:
					"Builders only. The sender signs `<timestamp>.<raw body>` with the secret (HMAC-SHA256, hex) and sends X-Tedix-Timestamp (Unix seconds) and X-Tedix-Signature: sha256=<hex>. Renaming the trigger rotates the secret.",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					triggerId: z.string().min(1).max(40),
				}).strict(),
			)
			.output(z.object({ url: z.string().url(), secret: z.string() })),
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
						/** The call's access check, so a read need not repeat it. */
						callGrant: z.string().max(4000).optional(),
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
