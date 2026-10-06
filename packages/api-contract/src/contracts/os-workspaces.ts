import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";
import { ExecutionRequirementSchema } from "../schemas/execution-evidence";
import {
	OsBlueprintDefinitionSchema,
	OsBlueprintResourceBindingSchema,
	OsBlueprintPreflightSchema,
	OsBlueprintExportSchema,
	OsBlueprintRevisionSchema,
	OsBlueprintSchema,
	OsBlueprintStatusSchema,
	OsBlueprintUpgradeReportSchema,
	OsWorkspaceBlueprintDecisionSchema,
	OsGadgetExecutionSchema,
	OsGadgetExecutionStatusSchema,
	OsGadgetExportDescriptorSchema,
	OsGadgetManifestSchema,
	OsGadgetRevisionSchema,
	OsDocumentPatchOpSchema,
	OsPresentationPatchOpSchema,
	OsGadgetSchema,
	OsGadgetStatusSchema,
	OsCollaborationDocumentTypeSchema,
	OsCollaborationProposalSchema,
	OsCollaborationProposalStatusSchema,
	OsCollaborationSourceKindSchema,
	OsOutputContentSchema,
	OsOutputExportFormatSchema,
	OsOutputKindSchema,
	OsOutputLibraryItemSchema,
	OsOutputRevisionSchema,
	OsOutputSchema,
	OsOutputStatusSchema,
	OsSheetCellSchema,
	OsWorkspaceSchema,
	OsWorkspacePreferenceSchema,
	OsWorkspacePdfReadSchema,
	OsWorkspaceProjectSchema,
	OsWorkspaceProjectStatusSchema,
	OsWorkspaceResourceSchema,
	OsWorkspaceResourceSelectionSchema,
	OsWorkspaceResourceStatusSchema,
	OsWorkspaceStatusSchema,
} from "../schemas/os-workspaces";

/**
 * Tedix OS workspace domain: workspaces contain gadgets, gadgets carry
 * immutable revisions and governed execution receipts, and blueprints template
 * whole workspaces. D1 tables `os_workspaces` / `os_gadgets` /
 * `os_gadget_revisions` / `os_gadget_executions` / `os_blueprints` /
 * `os_blueprint_revisions` are canonical.
 *
 * Internal + MCP projection only — no REST publication. All path ids are
 * UUIDs, never slugs. Revision writes are optimistic-concurrency guarded:
 * passing `expectedRevision` turns the write into a compare-and-swap, and a
 * lost swap surfaces as the typed `CONFLICT` error carrying the revision the
 * store actually holds.
 */

const revisionConflictErrors = {
	CONFLICT: {
		message: "Revision conflict",
		data: z
			.object({
				expectedRevision: z.number().int(),
				currentRevision: z
					.number()
					.int()
					.nullable()
					.describe(
						"Latest persisted revision at conflict time; null when no revision exists yet",
					),
			})
			.optional()
			.describe(
				"Present when an expectedRevision compare-and-swap lost against a concurrent revision write",
			),
	},
} as const;

const listLimitSchema = z.number().int().min(1).max(200).default(50);

/**
 * Instantiation refuses when a DEFINITIONAL dependency (a pinned skill, policy
 * pack, model/runtime constraint, layout, or output declaration) cannot resolve
 * to its exact pin in the caller's organization. The error carries the whole
 * preflight envelope so the caller sees which pin failed and why, without a
 * second round trip.
 */
const preflightBlockedErrors = {
	UNPROCESSABLE_CONTENT: {
		message: "Blueprint dependency preflight blocked instantiation",
		data: z
			.object({ preflight: OsBlueprintPreflightSchema })
			.optional()
			.describe(
				"Present when a pinned dependency failed to resolve; nothing was created",
			),
	},
} as const;

/**
 * Catalog visibility of a blueprint: `org` keeps it private to its
 * organization; `catalog` lists a PUBLISHED blueprint in the
 * cross-organization gallery.
 */
export const OsBlueprintVisibilitySchema = z.enum(["org", "catalog"]);
export type OsBlueprintVisibility = z.infer<typeof OsBlueprintVisibilitySchema>;

/** Blueprint wire shape including catalog visibility (D1 `os_blueprints.visibility`). */
export const OsBlueprintWithVisibilitySchema = OsBlueprintSchema.extend({
	visibility: OsBlueprintVisibilitySchema.describe(
		"Catalog visibility: `catalog` lists the published blueprint in the cross-organization gallery; `org` keeps it private",
	),
});
export type OsBlueprintWithVisibility = z.infer<
	typeof OsBlueprintWithVisibilitySchema
>;

/**
 * One cross-organization gallery listing. These fields are the ONLY blueprint
 * data that crosses the organization boundary — no definition, no creator
 * identity, no revision ids.
 */
export const OsBlueprintGalleryItemSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Operator-facing summary; null when never set"),
	gadgetCount: z
		.number()
		.int()
		.nonnegative()
		.describe("Gadget count declared by the published revision's definition"),
	organizationName: z
		.string()
		.describe("Display name of the organization that published the blueprint"),
	publishedAt: z
		.string()
		.nullable()
		.describe("When the served revision was published"),
});
export type OsBlueprintGalleryItem = z.infer<
	typeof OsBlueprintGalleryItemSchema
>;

const workspaceIdInput = z.object({ workspaceId: z.string().uuid() });
const gadgetIdInput = workspaceIdInput.extend({
	gadgetId: z.string().uuid(),
});
const blueprintIdInput = z.object({ blueprintId: z.string().uuid() });
const executionIdInput = gadgetIdInput.extend({
	executionId: z.string().uuid(),
});
const outputIdInput = z.object({ outputId: z.string().uuid() });
const proposalIdInput = z.object({ proposalId: z.string().uuid() });

const proposalDecisionInput = proposalIdInput.extend({
	expectedSequence: z.number().int().nonnegative(),
	rationale: z
		.string()
		.trim()
		.min(1)
		.max(4000)
		.describe("Auditable reason for the acceptance, rejection, or merge"),
	evidenceRefs: z.array(z.string().min(1).max(1024)).max(100).default([]),
});

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z
	.string()
	.max(2000)
	.optional()
	.describe("Optional operator-facing summary; stored null when omitted");

const workspaceUpdateSchema = z
	.object({
		workspaceId: z.string().uuid(),
		name: nameSchema
			.optional()
			.describe(
				"Updated operator-facing name; optional for description-only changes",
			),
		description: z
			.string()
			.max(2000)
			.nullable()
			.optional()
			.describe("Updated operator-facing summary; null clears it"),
	})
	.refine(
		(input) => input.name !== undefined || input.description !== undefined,
		{
			message: "Supply a workspace name or description to update",
		},
	);

export const osWorkspacesContract = oc
	.route({ tags: ["os-workspaces"], prefix: "/os-workspaces" })
	.errors(baseErrors)
	.router({
		workspaces: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspaces",
					summary: "List Tedix OS workspaces",
				})
				.input(
					z.object({
						status: OsWorkspaceStatusSchema.optional().describe(
							"Filter by lifecycle status; omitted returns all statuses",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsWorkspaceSchema),
						/** True when more rows exist beyond `limit`. */
						truncated: z.boolean(),
					}),
				),
			create: oc
				.route({
					method: "POST",
					path: "/workspaces",
					summary: "Create a Tedix OS workspace",
				})
				.input(
					z.object({
						name: nameSchema,
						description: descriptionSchema,
					}),
				)
				.output(z.object({ workspace: OsWorkspaceSchema })),
			get: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}",
					summary: "Get a Tedix OS workspace",
				})
				.input(workspaceIdInput)
				.output(z.object({ workspace: OsWorkspaceSchema })),
			update: oc
				.route({
					method: "PATCH",
					path: "/workspaces/{workspaceId}",
					summary: "Update Tedix OS workspace metadata",
					description:
						"Renames a workspace and/or changes its operator-facing description. Workspace identity, tenant ownership, provenance, and lifecycle status are immutable through this verb.",
				})
				.input(workspaceUpdateSchema)
				.output(z.object({ workspace: OsWorkspaceSchema })),
			archive: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/archive",
					summary: "Archive a Tedix OS workspace",
				})
				.input(workspaceIdInput)
				.output(z.object({ workspace: OsWorkspaceSchema })),
			delete: oc
				.route({
					method: "DELETE",
					path: "/workspaces/{workspaceId}",
					summary: "Permanently delete an archived Tedix OS workspace",
					description:
						"Requires os:admin, an already-archived workspace, no retained collaboration proposals, and no unrevoked share links. Cascades its Gadgets; outputs and immutable execution/audit evidence deliberately survive by stable id.",
				})
				.input(workspaceIdInput)
				.output(z.object({ deleted: z.literal(true) })),
			previewBlueprintUpgrade: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/blueprint-upgrade",
					summary: "Preview a blueprint upgrade for a Tedix OS workspace",
					description:
						"Read-only compatibility report between the revision the workspace is PINNED to and a candidate revision of the same blueprint (its current revision by default). It resolves three preflights against the CALLER's organization — the stored instantiation envelope, the pinned revision re-resolved now, and the candidate resolved now — and diffs them in the platform's single preflight vocabulary, so requirement drift under an unchanged pin is reported as drift rather than blamed on the upgrade. Nothing is written and no authority is minted. A hand-created workspace, or one whose source blueprint no longer exists in this organization, fails BAD_REQUEST rather than reporting a comparison it could not make.",
				})
				.input(
					workspaceIdInput
						.extend({
							candidateRevisionId: z
								.string()
								.uuid()
								.optional()
								.describe(
									"Revision of the workspace's source blueprint to evaluate; defaults to that blueprint's current revision",
								),
							tediId: z
								.string()
								.uuid()
								.optional()
								.describe(
									"Tedi whose runtime profile model/runtime compatibility resolves against; without it a declared runtime requirement resolves `missing` on BOTH sides, never assumed satisfied",
								),
						})
						.strict(),
				)
				.output(z.object({ report: OsBlueprintUpgradeReportSchema })),
			decideBlueprintUpgrade: oc
				.errors(preflightBlockedErrors)
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/blueprint-upgrade",
					summary: "Apply or explicitly stay pinned on a blueprint upgrade",
					description:
						"Records the operator's explicit decision about a named candidate revision, backed by the same report previewBlueprintUpgrade returns (it is re-resolved here, so the recorded evidence is never stale). `stay_pinned` changes no pin and no gadget — it writes the decision, which is what separates a reviewed workspace from an unreviewed one. `apply` re-pins the workspace and reconciles its gadgets in ONE D1 batch: gadgets the candidate adds are created at revision 1, gadgets whose manifest changed get an appended revision, gadgets the candidate drops are archived, and the workspace keeps the revision it left as its rollback reference together with the preflight envelope recorded there. Every write in the batch is fenced on the pin the decision was computed against, so a concurrent apply fails CONFLICT with nothing half-written. An apply whose candidate has an unresolvable definitional pin fails UNPROCESSABLE_CONTENT carrying the preflight; staying pinned is always allowed, since a blocked candidate is exactly when an operator chooses to stay.",
				})
				.input(
					workspaceIdInput.extend({
						decision: z
							.enum(["apply", "stay_pinned"])
							.describe("The explicit choice being recorded"),
						candidateRevisionId: z
							.string()
							.uuid()
							.describe(
								"The revision reviewed. Required: a decision names what was looked at",
							),
						reason: z
							.string()
							.max(2000)
							.optional()
							.describe("Operator's stated reason, recorded with the decision"),
						tediId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Tedi to resolve model/runtime compatibility against; required in practice whenever the candidate declares runtime requirements",
							),
					}),
				)
				.output(
					z.object({
						workspace: OsWorkspaceSchema,
						/** The report the decision was recorded against. */
						report: OsBlueprintUpgradeReportSchema,
						decision: OsWorkspaceBlueprintDecisionSchema,
					}),
				),
		}),
		workspacePreferences: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspace-preferences",
					summary: "List personal Tedix OS workspace preferences",
					description:
						"Returns presentation-only favorite and recency metadata for the current user. Workspace ownership and lifecycle remain authoritative in os_workspaces.",
				})
				.input(z.object({}))
				.output(z.object({ items: z.array(OsWorkspacePreferenceSchema) })),
			setFavorite: oc
				.route({
					method: "PUT",
					path: "/workspaces/{workspaceId}/favorite",
					summary: "Set a personal workspace favorite",
				})
				.input(workspaceIdInput.extend({ favorite: z.boolean() }))
				.output(z.object({ preference: OsWorkspacePreferenceSchema })),
			touch: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/touch",
					summary: "Record a personal workspace visit",
				})
				.input(workspaceIdInput)
				.output(z.object({ preference: OsWorkspacePreferenceSchema })),
		}),
		resources: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/resources",
					summary: "List external resources selected for a Workspace",
					description:
						"Returns non-secret provider object references. Connection credentials remain canonical in the MCP gateway and are never returned here.",
				})
				.input(
					workspaceIdInput.extend({
						status: OsWorkspaceResourceStatusSchema.optional().describe(
							"Filter by lifecycle status; omitted returns active and removed references",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsWorkspaceResourceSchema),
						truncated: z.boolean(),
					}),
				),
			create: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/resources",
					summary: "Add a concrete external resource to a Workspace",
					description:
						"Stores only a provider reference and required connection scope. It does not create, copy, or persist a provider credential.",
				})
				.input(
					workspaceIdInput.extend({
						selection: OsWorkspaceResourceSelectionSchema,
					}),
				)
				.output(z.object({ resource: OsWorkspaceResourceSchema })),
			readPdf: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/resources/{resourceId}/pdf",
					summary: "Read pages from an exact Workspace-bound PDF",
					description:
						"Reads the current provider file through its scoped connection and returns bounded, page-numbered text with a content hash. The attached resource reference alone does not grant provider access.",
				})
				.input(
					workspaceIdInput.extend({
						resourceId: z.string().uuid(),
						pageStart: z.number().int().min(1).max(1000).default(1),
						pageLimit: z.number().int().min(1).max(2).default(1),
						charOffset: z.number().int().min(0).max(200000).default(0),
					}),
				)
				.output(z.object({ pdf: OsWorkspacePdfReadSchema })),
			get: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/resources/{resourceId}",
					summary: "Get one Workspace resource reference",
				})
				.input(workspaceIdInput.extend({ resourceId: z.string().uuid() }))
				.output(z.object({ resource: OsWorkspaceResourceSchema })),
			startRepositoryWork: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/resources/{resourceId}/repository-work",
					summary: "Prepare governed work for a Workspace repository",
					description:
						"Creates or reuses one accepted canonical Work Item linked to an active Workspace project. The returned dispatch is submitted through Home/kernel; repository credentials remain in the canonical connection and GitHub App authorities.",
				})
				.input(
					workspaceIdInput
						.extend({
							resourceId: z.string().uuid(),
							expectedUpdatedAt: z.string().min(1),
							projectId: z.string().uuid(),
							tediId: z.string().uuid(),
							task: z.string().trim().min(1).max(200),
							outcome: z.string().trim().min(1).max(2000),
							idempotencyKey: z.string().uuid(),
						})
						.strict(),
				)
				.output(
					z
						.object({
							workItemId: z.string().uuid(),
							dispatch: z
								.object({
									content: z.string(),
									delegateToTediId: z.string().uuid(),
									idempotencyKey: z.string().uuid(),
									workspaceContext: z
										.object({ workspaceId: z.string().uuid() })
										.strict(),
									metadata: z
										.object({
											executionRequirement: ExecutionRequirementSchema,
											needsEmbodiedSurface: z.literal(true),
											repository: z
												.object({
													repositoryId: z.number().int().positive(),
													fullName: z.string(),
													installationId: z.number().int().positive(),
													providerId: z.literal("github"),
													resourceId: z.string().uuid(),
												})
												.strict(),
											workItemId: z.string().uuid(),
										})
										.strict(),
								})
								.strict(),
						})
						.strict(),
				),
			rebind: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/resources/{resourceId}/rebind",
					summary:
						"Change the connection requirement for one Workspace resource",
					description:
						"Preserves the Workspace resource ID and exact provider object while changing its personal or organization connection requirement. Uses expectedUpdatedAt to reject stale edits. Does not move or copy a credential.",
				})
				.input(
					workspaceIdInput.extend({
						resourceId: z.string().uuid(),
						expectedUpdatedAt: z.string(),
						connectionScope: z.enum(["tenant", "user"]),
						requiredScopes: z
							.array(z.string().trim().min(1).max(300))
							.max(50)
							.optional()
							.describe("Omit to retain the current required scopes"),
					}),
				)
				.output(z.object({ resource: OsWorkspaceResourceSchema })),
			rename: oc
				.route({
					method: "PATCH",
					path: "/workspaces/{workspaceId}/resources/{resourceId}",
					summary: "Rename a Workspace resource reference",
				})
				.input(
					workspaceIdInput.extend({
						resourceId: z.string().uuid(),
						name: nameSchema,
						expectedUpdatedAt: z.string(),
					}),
				)
				.output(z.object({ resource: OsWorkspaceResourceSchema })),
			remove: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/resources/{resourceId}/remove",
					summary:
						"Remove a Workspace resource without revoking its connection",
					description:
						"Marks the reference removed for audit and dependency history. The underlying personal or organization connection is unchanged.",
				})
				.input(
					workspaceIdInput.extend({
						resourceId: z.string().uuid(),
						expectedUpdatedAt: z.string(),
					}),
				)
				.output(z.object({ resource: OsWorkspaceResourceSchema })),
		}),
		work: oc.router({
			listProjects: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/work/projects",
					summary: "List canonical Work projects linked to a Workspace",
					description:
						"Defines the native Work view scope without copying Work Items, milestones, dependencies, or status into the Workspace domain.",
				})
				.input(
					workspaceIdInput
						.extend({
							status: OsWorkspaceProjectStatusSchema.optional().describe(
								"Lifecycle filter; omitted returns active and removed project links",
							),
							limit: listLimitSchema,
						})
						.strict(),
				)
				.output(
					z.object({
						items: z.array(OsWorkspaceProjectSchema),
						truncated: z.boolean(),
					}),
				),
			attachProject: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/work/projects",
					summary: "Link a canonical Work project to a Workspace",
				})
				.input(workspaceIdInput.extend({ projectId: z.string().uuid() }))
				.output(z.object({ link: OsWorkspaceProjectSchema })),
			removeProject: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/work/projects/{projectId}/remove",
					summary: "Remove a Work project from a Workspace view",
				})
				.input(
					workspaceIdInput.extend({
						projectId: z.string().uuid(),
						expectedUpdatedAt: z.string(),
					}),
				)
				.output(z.object({ link: OsWorkspaceProjectSchema })),
		}),
		gadgets: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/gadgets",
					summary: "List gadgets in a Tedix OS workspace",
				})
				.input(
					workspaceIdInput.extend({
						status: OsGadgetStatusSchema.optional().describe(
							"Filter by lifecycle status; omitted returns all statuses",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsGadgetSchema),
						/** True when more rows exist beyond `limit`. */
						truncated: z.boolean(),
					}),
				),
			create: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/gadgets",
					summary: "Create a Tedix OS gadget",
					description:
						"Creates the gadget record only; the first `gadgets.revise` call records revision 1 and sets currentRevisionId.",
				})
				.input(
					workspaceIdInput.extend({
						name: nameSchema,
						description: descriptionSchema,
					}),
				)
				.output(z.object({ gadget: OsGadgetSchema })),
			get: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}",
					summary: "Get a Tedix OS gadget with its current revision",
				})
				.input(gadgetIdInput)
				.output(
					z.object({
						gadget: OsGadgetSchema,
						currentRevision: OsGadgetRevisionSchema.nullable().describe(
							"Null until the first revision is recorded",
						),
					}),
				),
			revise: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/revisions",
					summary: "Record a new Tedix OS gadget revision",
					description:
						"Appends the next revision (max+1) and advances currentRevisionId in one D1 batch. With expectedRevision set, a concurrent revision write fails as the typed CONFLICT error instead of double-writing.",
				})
				.input(
					gadgetIdInput.extend({
						manifest: OsGadgetManifestSchema,
						sourceArtifactRef: z
							.string()
							.min(1)
							.max(512)
							.optional()
							.describe(
								"Reference to the built artifact this revision was recorded from; omit for manifest-only revisions",
							),
						expectedRevision: z
							.number()
							.int()
							.nonnegative()
							.optional()
							.describe(
								"Optimistic-concurrency guard: the current revision number the caller last read (0 for a gadget with no revisions). Omitted writes append unconditionally.",
							),
					}),
				)
				.output(
					z.object({
						gadget: OsGadgetSchema,
						revision: OsGadgetRevisionSchema,
					}),
				),
			archive: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/archive",
					summary: "Archive a Tedix OS gadget",
				})
				.input(gadgetIdInput)
				.output(z.object({ gadget: OsGadgetSchema })),
			run: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/executions",
					summary: "Run a Tedix OS gadget under policy admission",
					description:
						"Dispatches a governed execution against the gadget's current revision and records the receipt: actor, executing tedi, pinned revision, granted capabilities, policy decision, and runtime lineage. Requested capabilities must be a subset of the revision manifest's declared capabilities; an archived gadget, a gadget with no revision, or an undeclared capability records a denied receipt instead of executing. The manifest's governed skill (skillSlug, or entry when it is a skill slug) executes through skill-runtime after capability/policy preflight and inference-budget admission. A missing/non-executable skill, blocked preflight, or budget denial records a denied receipt with reasons. Policy-required approval, or an explicit approvalMode of required, parks the receipt awaiting_approval with a human approval request; otherwise the receipt pins the dispatched run lineage and the runtime settles it. Callers never self-report execution completion.",
				})
				.input(
					gadgetIdInput.extend({
						input: JsonValueSchema.optional().describe(
							"Execution input recorded on the receipt and passed to the dispatched skill as params; omit when the run takes none",
						),
						capabilities: z
							.array(z.string().min(1).max(200))
							.max(100)
							.optional()
							.describe(
								"Capabilities requested for this run; defaults to every capability the current revision declares",
							),
						tediId: z
							.string()
							.uuid()
							.describe(
								"The organization-owned tedi that executes this governed run",
							),
						approvalMode: z
							.enum(["policy", "required"])
							.default("policy")
							.describe(
								"policy follows the active tenant policy; required is a one-way stricter caller posture that always parks for explicit human approval and can never bypass a policy approval",
							),
						workItemId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Work Item to admit with the dispatched run; recorded on the receipt lineage",
							),
						idempotencyKey: z
							.string()
							.min(1)
							.max(128)
							.optional()
							.describe(
								"Stable caller key: repeats derive the same execution id, so a duplicate returns the already-recorded receipt instead of admitting twice. Defaults to a random key (no dedupe)",
							),
					}),
				)
				.output(
					z.object({
						execution: OsGadgetExecutionSchema.describe(
							"The runtime-owned receipt: denied when admission refused it, awaiting_approval when parked for a human decision, or queued/running/completed/failed/canceled from governed runtime evidence",
						),
					}),
				),
			delete: oc
				.route({
					method: "DELETE",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}",
					summary: "Permanently delete an archived Tedix OS gadget",
					description:
						"Requires os:admin, an already-archived Gadget, and no unrevoked share links. Deletes its immutable revision rows; execution and audit evidence deliberately survive by stable id.",
				})
				.input(gadgetIdInput)
				.output(z.object({ deleted: z.literal(true) })),
		}),
		outputs: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/outputs",
					summary: "List Tedix OS outputs",
				})
				.input(
					z.object({
						workspaceId: z
							.string()
							.uuid()
							.optional()
							.describe("Filter to outputs grouped under one workspace"),
						kind: OsOutputKindSchema.optional().describe(
							"Filter by output format; omitted returns all kinds",
						),
						status: OsOutputStatusSchema.optional().describe(
							"Filter by lifecycle status; omitted returns all statuses",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsOutputSchema),
						/** True when more rows exist beyond `limit`. */
						truncated: z.boolean(),
					}),
				),
			library: oc
				.route({
					method: "GET",
					path: "/output-library",
					summary: "List Tedix OS outputs with compact previews and provenance",
					description:
						"Returns bounded, inert previews plus canonical workspace and creator provenance. Archived workspaces do not hide their durable outputs.",
				})
				.input(
					z.object({
						workspaceId: z
							.string()
							.uuid()
							.optional()
							.describe("Optional workspace grouping filter"),
						kind: OsOutputKindSchema.optional().describe(
							"Optional format filter; omitted returns every output kind",
						),
						status: OsOutputStatusSchema.optional().describe(
							"Optional output lifecycle filter; omitted returns active and archived outputs",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsOutputLibraryItemSchema),
						truncated: z.boolean(),
					}),
				),
			create: oc
				.route({
					method: "POST",
					path: "/outputs",
					summary: "Create a Tedix OS output",
					description:
						"Creates the output with its revision-1 semantic body in one atomic write. Omit `content` to start from an empty body of the declared kind and fill it with the granular editing tools; supply it to seed the artifact in one call. The content body's kind must match the declared output kind (BAD_REQUEST otherwise); a given workspaceId must name a workspace in the caller's organization.",
				})
				.input(
					z.object({
						kind: OsOutputKindSchema,
						title: nameSchema,
						workspaceId: z
							.string()
							.uuid()
							.optional()
							.describe("Optional workspace to group the output under"),
						content: OsOutputContentSchema.optional().describe(
							"Optional initial body. Omit it to create an empty artifact of the declared kind — an empty document, sheet, or presentation — and fill it afterwards with patchDocument or setSheetRange. A video must supply its body, because a video without a renderId names nothing.",
						),
						note: z
							.string()
							.max(2_000)
							.optional()
							.describe("Optional revision message for the initial body"),
					}),
				)
				.output(
					z.object({
						output: OsOutputSchema,
						revision: OsOutputRevisionSchema,
					}),
				),
			get: oc
				.route({
					method: "GET",
					path: "/outputs/{outputId}",
					summary: "Get a Tedix OS output with its current revision",
				})
				.input(outputIdInput)
				.output(
					z.object({
						output: OsOutputSchema,
						currentRevision: OsOutputRevisionSchema,
						authoringHomeRun: z
							.object({ runId: z.string() })
							.nullable()
							.describe(
								"Exact current-revision authoring run when evidence and conversation access permit; null means unavailable, not human-authored. Run cost is not allocated output cost.",
							),
					}),
				),
			rename: oc
				.route({
					method: "PATCH",
					path: "/outputs/{outputId}",
					summary: "Rename a Tedix OS output",
					description:
						"Updates only the mutable library title; immutable output revisions and content remain unchanged.",
				})
				.input(outputIdInput.extend({ title: nameSchema }))
				.output(z.object({ output: OsOutputSchema })),
			revise: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/outputs/{outputId}/revisions",
					summary: "Record a new Tedix OS output revision",
					description:
						"Appends the next semantic body (max+1) and advances currentRevisionId in one D1 batch. Every append captures the current revision and compare-and-swap fences that exact base, preserving its source-access requirements together with any new producer requirements; editing or redacting content does not implicitly declassify those sources. The body's kind must match the output's kind. For assistant edits to an existing workspace document, prefer collaboration.create and updatePreview so the user can review and apply changes without advancing the saved version behind a live draft. Direct revision writes do not merge with live editor changes. Supply expectedRevision when the caller also requires the current revision to equal a previously read value; otherwise the server still rejects a concurrent change after its own base capture with typed CONFLICT.",
				})
				.input(
					outputIdInput.extend({
						content: OsOutputContentSchema,
						note: z
							.string()
							.max(2_000)
							.optional()
							.describe("Optional revision message describing the edit"),
						expectedRevision: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Additional optimistic-concurrency precondition: the current revision number the caller last read. When omitted, the server still captures and CAS-fences the base revision whose source-access requirements the new revision inherits.",
							),
					}),
				)
				.output(
					z.object({
						output: OsOutputSchema,
						revision: OsOutputRevisionSchema,
					}),
				),
			patchDocument: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/outputs/{outputId}/document/patch",
					summary: "Patch a Tedix OS document output block-by-block",
					description:
						"Applies ordered insert/replace/delete block operations server-side against the current document revision and persists the result as the next revision through the same compare-and-swap write path as outputs.revise. Indices are bounds-checked against the evolving block list — an out-of-range index or a non-document output fails BAD_REQUEST; a concurrent revision write fails as the typed CONFLICT error.",
				})
				.input(
					outputIdInput.extend({
						ops: z.array(OsDocumentPatchOpSchema).min(1).max(100),
						note: z
							.string()
							.max(2_000)
							.optional()
							.describe("Optional revision message describing the edit"),
						expectedRevision: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Optimistic-concurrency guard: the current revision number the caller last read. Omitted patches still swap against the revision the ops were applied to.",
							),
					}),
				)
				.output(
					z.object({
						output: OsOutputSchema,
						revision: OsOutputRevisionSchema,
					}),
				),
			patchSlides: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/outputs/{outputId}/slides/patch",
					summary: "Patch a Tedix OS presentation output slide-by-slide",
					description:
						"Applies ordered insert/replace/delete/move slide operations server-side against the current presentation revision and persists the result as the next revision through the same compare-and-swap write path as outputs.revise. Each operation carries a slide OUTLINE — title, bullets, optional notes — and the router lays out the canvas slide, so an agent describes a slide rather than positioning 300 elements. The visual deck and its semantic projection are kept consistent: a deck is never dropped by a patch, and a presentation that has no deck yet gains one. Indices are bounds-checked against the evolving slide list — an out-of-range index or a non-presentation output fails BAD_REQUEST; a concurrent revision write fails as the typed CONFLICT error.",
				})
				.input(
					outputIdInput.extend({
						ops: z.array(OsPresentationPatchOpSchema).min(1).max(100),
						note: z
							.string()
							.max(2_000)
							.optional()
							.describe("Optional revision message describing the edit"),
						expectedRevision: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Optimistic-concurrency guard: the current revision number the caller last read. Omitted patches still swap against the revision the ops were applied to.",
							),
					}),
				)
				.output(
					z.object({
						output: OsOutputSchema,
						revision: OsOutputRevisionSchema,
					}),
				),
			setSheetRange: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/outputs/{outputId}/sheet/range",
					summary: "Write a cell rectangle into a Tedix OS sheet output",
					description:
						"Writes the rectangle into the current sheet revision starting at (startRow, startColumn) and persists the result as the next revision through the same compare-and-swap write path as outputs.revise. Rows are extended null-filled up to the 1000-row cap; columns are added by editors, not by range writes, so the rectangle must fit the current column count (BAD_REQUEST otherwise, as is a non-sheet output). A concurrent revision write fails as the typed CONFLICT error.",
				})
				.input(
					outputIdInput.extend({
						startRow: z.number().int().nonnegative(),
						startColumn: z.number().int().nonnegative(),
						cells: z
							.array(z.array(OsSheetCellSchema).min(1).max(64))
							.min(1)
							.max(200),
						note: z
							.string()
							.max(2_000)
							.optional()
							.describe("Optional revision message describing the edit"),
						expectedRevision: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Optimistic-concurrency guard: the current revision number the caller last read. Omitted writes still swap against the revision the rectangle was applied to.",
							),
					}),
				)
				.output(
					z.object({
						output: OsOutputSchema,
						revision: OsOutputRevisionSchema,
					}),
				),
			export: oc
				.route({
					method: "POST",
					path: "/outputs/{outputId}/exports",
					summary: "Export a Tedix OS output as PDF, PNG, or an Office file",
					description:
						"pdf and png render the output's current revision as a self-contained HTML document and print or photograph it through Cloudflare Browser Rendering (never inside the OS worker); xlsx, docx and pptx are written directly from the content model, so cells, formulas, sheet structure and slide geometry survive as real Office files. The bytes are stored in R2 and the authenticated download URL is returned. Fails BAD_REQUEST when a rendered format is asked for without Browser Rendering configured, or when a format does not apply to the output's kind.",
				})
				.input(
					outputIdInput.extend({
						format: OsOutputExportFormatSchema,
					}),
				)
				.output(
					z.object({
						/** R2 object key the export bytes were stored under. */
						key: z.string(),
						format: OsOutputExportFormatSchema,
						/** The output revision the export rendered. */
						revision: z.number().int().positive(),
						sizeBytes: z.number().int().nonnegative(),
						/** Authenticated download URL (Bearer JWT or session cookie). */
						url: z.string(),
					}),
				),
			archive: oc
				.route({
					method: "POST",
					path: "/outputs/{outputId}/archive",
					summary: "Archive a Tedix OS output",
				})
				.input(outputIdInput)
				.output(z.object({ output: OsOutputSchema })),
			delete: oc
				.route({
					method: "DELETE",
					path: "/outputs/{outputId}",
					summary: "Permanently delete an archived Tedix OS output",
					description:
						"Requires os:admin, an already-archived output, no retained collaboration proposals, and no unrevoked share links. Deletes its immutable semantic revisions while audit records and revoked share-link history remain independently attributable by stable id.",
				})
				.input(outputIdInput)
				.output(z.object({ deleted: z.literal(true) })),
		}),
		executions: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/executions",
					summary: "List Tedix OS gadget execution receipts",
				})
				.input(
					gadgetIdInput.extend({
						status: OsGadgetExecutionStatusSchema.optional().describe(
							"Filter by receipt status; omitted returns all statuses",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsGadgetExecutionSchema),
						/** True when more rows exist beyond `limit`. */
						truncated: z.boolean(),
					}),
				),
			get: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/executions/{executionId}",
					summary: "Get a Tedix OS gadget execution receipt",
				})
				.input(executionIdInput)
				.output(z.object({ execution: OsGadgetExecutionSchema })),
			export: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/gadgets/{gadgetId}/executions/{executionId}/exports",
					summary: "Download a declared Gadget execution export",
					description:
						"Resolves the descriptor from the exact Gadget revision pinned by the completed execution, verifies the successful skill-run artifact and its declared media type, and mints a short-lived attachment URL. Source-derived executions are refused because a bearer URL cannot carry viewer-time source authorization.",
				})
				.input(
					executionIdInput.extend({
						exportId: OsGadgetExportDescriptorSchema.shape.id,
					}),
				)
				.output(
					z.object({
						descriptor: OsGadgetExportDescriptorSchema,
						fileName: z.string(),
						sizeBytes: z.number().int().nonnegative(),
						url: z.string().url(),
						urlExpiresAt: z.string(),
					}),
				),
		}),
		collaboration: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/workspaces/{workspaceId}/collaboration-proposals",
					summary: "List agent collaboration proposals for a Canvas workspace",
					description:
						"Lists durable proposal previews independently from the live collaborative draft. Filters are tenant-scoped and a preview is never canonical artifact content.",
				})
				.input(
					workspaceIdInput.extend({
						documentType: OsCollaborationDocumentTypeSchema.optional().describe(
							"Optional document-kind filter; omitted lists both Gadgets and outputs",
						),
						documentId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Optional document filter; omitted lists the whole workspace",
							),
						statuses: z
							.array(OsCollaborationProposalStatusSchema)
							.max(4)
							.optional()
							.describe(
								"Optional lifecycle filter; omitted includes every status",
							),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsCollaborationProposalSchema),
						truncated: z.boolean(),
					}),
				),
			get: oc
				.route({
					method: "GET",
					path: "/collaboration-proposals/{proposalId}",
					summary: "Get one agent collaboration proposal",
				})
				.input(proposalIdInput)
				.output(z.object({ proposal: OsCollaborationProposalSchema })),
			create: oc
				.route({
					method: "POST",
					path: "/workspaces/{workspaceId}/collaboration-proposals",
					summary: "Create an agent collaboration proposal",
					description:
						"Preferred assistant editing path for an existing workspace document. The claimed source must exactly match the authenticated workflow run or external-agent session; chat lineage is unsupported until it has an attested transport identity. Pins the proposal to the current immutable revision and records a non-canonical preview. Use updatePreview from the same producer to refine it, then let the workspace Review UI apply it after any live draft is saved.",
				})
				.input(
					workspaceIdInput.extend({
						documentType: OsCollaborationDocumentTypeSchema,
						documentId: z.string().uuid(),
						sourceKind: OsCollaborationSourceKindSchema,
						sourceId: z.string().min(1).max(512),
						content: JsonValueSchema,
					}),
				)
				.output(z.object({ proposal: OsCollaborationProposalSchema })),
			updatePreview: oc
				.route({
					method: "POST",
					path: "/collaboration-proposals/{proposalId}/preview",
					summary: "Advance an agent collaboration proposal preview",
					description:
						"Replaces the latest full preview and increments its streaming sequence under compare-and-swap. Only the server-attested producer of an open proposal can advance it; this never writes a canonical revision.",
				})
				.input(
					proposalIdInput.extend({
						expectedSequence: z.number().int().nonnegative(),
						content: JsonValueSchema,
					}),
				)
				.output(z.object({ proposal: OsCollaborationProposalSchema })),
			accept: oc
				.route({
					method: "POST",
					path: "/collaboration-proposals/{proposalId}/accept",
					summary: "Accept and freeze an agent collaboration proposal",
					description:
						"Freezes the preview for review with rationale and evidence. Acceptance alone is not canonical; merge is a separate explicit operation.",
				})
				.input(proposalDecisionInput)
				.output(z.object({ proposal: OsCollaborationProposalSchema })),
			reject: oc
				.route({
					method: "POST",
					path: "/collaboration-proposals/{proposalId}/reject",
					summary: "Reject an agent collaboration proposal",
					description:
						"Rejects an open or accepted proposal with an auditable rationale and evidence without changing canonical content.",
				})
				.input(proposalDecisionInput)
				.output(z.object({ proposal: OsCollaborationProposalSchema })),
			merge: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/collaboration-proposals/{proposalId}/merge",
					summary: "Merge an accepted collaboration proposal",
					description:
						"Appends the accepted preview as the next immutable gadget/output revision and settles the proposal in one D1 batch. A changed canonical base fails with a typed revision conflict; the live collaborative draft is never overwritten. This API does not inspect unsaved editor changes: applying from the workspace Review UI is preferred because it checks draft state. A direct merge can leave an edited live draft requiring version comparison.",
				})
				.input(proposalDecisionInput)
				.output(
					z.object({
						proposal: OsCollaborationProposalSchema,
						revision: z.union([OsGadgetRevisionSchema, OsOutputRevisionSchema]),
					}),
				),
		}),
		blueprints: oc.router({
			list: oc
				.route({
					method: "GET",
					path: "/blueprints",
					summary: "List Tedix OS blueprints",
				})
				.input(
					z.object({
						status: OsBlueprintStatusSchema.optional().describe(
							"Filter by lifecycle status; omitted returns all statuses",
						),
						limit: listLimitSchema,
					}),
				)
				.output(
					z.object({
						items: z.array(OsBlueprintWithVisibilitySchema),
						/** True when more rows exist beyond `limit`. */
						truncated: z.boolean(),
					}),
				),
			create: oc
				.route({
					method: "POST",
					path: "/blueprints",
					summary: "Create a Tedix OS blueprint",
					description:
						"Creates the blueprint in draft; the first `blueprints.revise` call records revision 1 and sets currentRevisionId.",
				})
				.input(
					z.object({
						name: nameSchema,
						description: descriptionSchema,
					}),
				)
				.output(z.object({ blueprint: OsBlueprintWithVisibilitySchema })),
			get: oc
				.route({
					method: "GET",
					path: "/blueprints/{blueprintId}",
					summary: "Get a Tedix OS blueprint with its current revision",
				})
				.input(blueprintIdInput)
				.output(
					z.object({
						blueprint: OsBlueprintWithVisibilitySchema,
						currentRevision: OsBlueprintRevisionSchema.nullable().describe(
							"Null until the first revision is recorded",
						),
					}),
				),
			revise: oc
				.errors(revisionConflictErrors)
				.route({
					method: "POST",
					path: "/blueprints/{blueprintId}/revisions",
					summary: "Record a new Tedix OS blueprint revision",
					description:
						"Appends the next revision (max+1) and advances currentRevisionId in one D1 batch. With expectedRevision set, a concurrent revision write fails as the typed CONFLICT error instead of double-writing.",
				})
				.input(
					blueprintIdInput.extend({
						definition: OsBlueprintDefinitionSchema,
						expectedRevision: z
							.number()
							.int()
							.nonnegative()
							.optional()
							.describe(
								"Optimistic-concurrency guard: the current revision number the caller last read (0 for a blueprint with no revisions). Omitted writes append unconditionally.",
							),
					}),
				)
				.output(
					z.object({
						blueprint: OsBlueprintWithVisibilitySchema,
						revision: OsBlueprintRevisionSchema,
					}),
				),
			publish: oc
				.route({
					method: "POST",
					path: "/blueprints/{blueprintId}/publish",
					summary: "Publish a Tedix OS blueprint",
					description:
						"Marks the blueprint published and stamps publishedAt on its current revision. Fails BAD_REQUEST when no revision exists yet.",
				})
				.input(blueprintIdInput)
				.output(
					z.object({
						blueprint: OsBlueprintWithVisibilitySchema,
						revision: OsBlueprintRevisionSchema,
					}),
				),
			archive: oc
				.route({
					method: "POST",
					path: "/blueprints/{blueprintId}/archive",
					summary: "Archive a Tedix OS blueprint",
					description:
						"Retracts the Blueprint from use and the cross-organization catalog while preserving its immutable revisions for inspection.",
				})
				.input(blueprintIdInput)
				.output(z.object({ blueprint: OsBlueprintWithVisibilitySchema })),
			delete: oc
				.route({
					method: "DELETE",
					path: "/blueprints/{blueprintId}",
					summary: "Permanently delete an archived Tedix OS blueprint",
					description:
						"Requires os:admin and an already-archived Blueprint. Deletes its revision rows; instantiated Workspaces retain denormalized provenance and preflight evidence by stable id.",
				})
				.input(blueprintIdInput)
				.output(z.object({ deleted: z.literal(true) })),
			preflight: oc
				.route({
					method: "GET",
					path: "/blueprints/{blueprintId}/preflight",
					summary: "Resolve a blueprint's pinned dependencies",
					description:
						"Read-only resolution of the blueprint's current revision's version-pinned requirements against the CALLER's organization. It never mints authority and never provisions. Each declared dependency returns one decision in the platform's shared preflight vocabulary: `allowed` (the exact pin resolved — this is the board's `available`), `missing`, `denied`, `incompatible` (the row resolved but the pinned revision/version moved, or the resolved model cannot satisfy the constraint), or `consent_required` (a user-present Descope Adaptive Connect round trip is needed). A kind with no decision was never declared. Pinned skills/policy packs resolve strictly inside the caller's organization, so a blueprint imported from another organization reports `missing`/`denied` instead of silently binding to a same-slug local row.",
				})
				.input(
					blueprintIdInput.extend({
						tediId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Tedi whose runtime profile model/runtime compatibility resolves against; without it a declared runtime requirement resolves `missing`, never assumed satisfied",
							),
						resourceBindings: z
							.array(OsBlueprintResourceBindingSchema)
							.max(25)
							.default([]),
					}),
				)
				.output(z.object({ preflight: OsBlueprintPreflightSchema })),
			instantiate: oc
				.errors(preflightBlockedErrors)
				.route({
					method: "POST",
					path: "/blueprints/{blueprintId}/instantiate",
					summary: "Instantiate a Tedix OS blueprint as a workspace",
					description:
						"Runs the dependency preflight, then materializes the blueprint's current published revision as a new workspace with every declared gadget at revision 1 — one D1 batch, so a failure creates nothing. Provenance recorded on the workspace is the exact pinned revision id AND number plus the preflight envelope (skills and policy packs version in place, so that evidence is not reconstructible later); each gadget records the declaring revision id. Only a published blueprint instantiates (BAD_REQUEST otherwise); a taken workspace name fails CONFLICT with nothing created; an unresolvable definitional pin fails UNPROCESSABLE_CONTENT carrying the preflight. Unsatisfied CONNECTIONS never block: instantiation copies no credential of any kind, so they surface as `needs_consent` on the recorded preflight for the operator to connect afterwards.",
				})
				.input(
					blueprintIdInput.extend({
						workspaceName: nameSchema.describe(
							"Name for the new workspace; unique per organization",
						),
						description: descriptionSchema,
						tediId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Tedi to resolve model/runtime compatibility against; required in practice whenever the revision declares runtime requirements",
							),
						resourceBindings: z
							.array(OsBlueprintResourceBindingSchema)
							.max(25)
							.default([]),
					}),
				)
				.output(
					z.object({
						workspace: OsWorkspaceSchema,
						blueprint: OsBlueprintWithVisibilitySchema,
						/** The exact blueprint revision that was materialized. */
						revision: OsBlueprintRevisionSchema,
						/** The dependency resolution recorded on the workspace. */
						preflight: OsBlueprintPreflightSchema,
						resources: z.array(OsWorkspaceResourceSchema),
						gadgets: z.array(
							z.object({
								gadget: OsGadgetSchema,
								revision: OsGadgetRevisionSchema,
							}),
						),
					}),
				),
			export: oc
				.route({
					method: "GET",
					path: "/blueprints/{blueprintId}/export",
					summary: "Export a Tedix OS blueprint revision",
					description:
						"Projects one revision of a blueprint the caller's organization owns into the portable, versioned export envelope. The envelope is an explicit ALLOWLIST — name, description, source lifecycle status, revision metadata, the typed definition (gadget manifests plus version-pinned requirements), the origin identity that makes the fork nameable later, and the blueprint's own fork ancestry. It carries no credential (requirement objects are `.strict()`, so none can be represented), no storage or artifact reference, no execution receipt, no output content, no chat/memory/rationale, no instantiation evidence, no catalog visibility, and no principal id — only principal KINDS. Nothing is written: this is a read.",
				})
				.input(
					blueprintIdInput.extend({
						revisionId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Revision to export; defaults to the blueprint's current revision",
							),
					}),
				)
				.output(z.object({ export: OsBlueprintExportSchema })),
			import: oc
				.route({
					method: "POST",
					path: "/blueprints/import",
					summary: "Import a Tedix OS blueprint export envelope",
					description:
						"Validates an export envelope and, only then, persists it as a new DRAFT blueprint in the caller's organization with its revision 1 — blueprint row and revision in ONE D1 batch, so a lost name race leaves nothing behind. Validation is real: the envelope must parse (unknown top-level keys are rejected outright) and its recorded content digest must match the digest of the definition it carries, otherwise BAD_REQUEST. What is persisted is the PARSED definition re-serialized, never the submitted bytes, so nothing outside the declared schema can land in this organization's D1. The import lands as `draft` with `org` visibility regardless of what the envelope says: an import never republishes another organization's blueprint into the gallery. Fork lineage is recorded from the envelope — the exported blueprint becomes the head of the chain, ahead of any ancestry it carried — so the origin stays nameable even when the source organization is unreachable. Pinned dependencies are NOT resolved here; run blueprints.preflight afterwards to see how they resolve in this organization.",
				})
				.input(
					z.object({
						export: OsBlueprintExportSchema,
						name: nameSchema
							.optional()
							.describe(
								"Name for the imported blueprint; defaults to the envelope's name. A taken name fails CONFLICT",
							),
					}),
				)
				.output(
					z.object({
						blueprint: OsBlueprintWithVisibilitySchema,
						revision: OsBlueprintRevisionSchema,
					}),
				),
			setVisibility: oc
				.route({
					method: "POST",
					path: "/blueprints/{blueprintId}/visibility",
					summary: "Set Tedix OS blueprint catalog visibility",
					description:
						"Only a published blueprint owned by the caller's organization may change visibility (BAD_REQUEST otherwise). `catalog` lists it in the cross-organization gallery — name, description, gadget count, and the organization's display name become visible to every authenticated tenant; `org` retracts it.",
				})
				.input(
					blueprintIdInput.extend({
						visibility: OsBlueprintVisibilitySchema,
					}),
				)
				.output(z.object({ blueprint: OsBlueprintWithVisibilitySchema })),
			gallery: oc
				.route({
					method: "GET",
					path: "/blueprint-gallery",
					summary: "List the cross-organization Tedix OS blueprint gallery",
					description:
						"Catalog-visible published blueprints across every organization. The item fields are the only blueprint data that crosses the organization boundary; instantiate one with blueprints.instantiateFromGallery.",
				})
				.input(z.object({ limit: listLimitSchema }))
				.output(z.object({ items: z.array(OsBlueprintGalleryItemSchema) })),
			instantiateFromGallery: oc
				.errors(preflightBlockedErrors)
				.route({
					method: "POST",
					path: "/blueprint-gallery/{blueprintId}/instantiate",
					summary:
						"Instantiate a gallery blueprint into the caller's organization",
					description:
						"Copies the gallery blueprint's current published revision into the caller's organization as a new published blueprint — recording gallery provenance in its description — then instantiates that copy as a workspace exactly like blueprints.instantiate. The copy and the workspace are written in ONE D1 batch, so a taken workspace name fails CONFLICT with nothing created, not even an orphan blueprint. The source resolves only while it is catalog-visible and published (NOT_FOUND otherwise, indistinguishable from a missing id). Preflight runs against the CALLER's organization: pinned skill ids and org-scoped policy packs from the publishing organization are not reachable here and fail UNPROCESSABLE_CONTENT rather than binding to a same-slug local row.",
				})
				.input(
					blueprintIdInput.extend({
						workspaceName: nameSchema.describe(
							"Name for the new workspace; unique per organization",
						),
						tediId: z
							.string()
							.uuid()
							.optional()
							.describe(
								"Tedi to resolve model/runtime compatibility against; without it a declared runtime requirement resolves `missing`",
							),
						resourceBindings: z
							.array(OsBlueprintResourceBindingSchema)
							.max(25)
							.default([]),
					}),
				)
				.output(
					z.object({
						workspace: OsWorkspaceSchema,
						/** The new published blueprint copied into the caller's organization. */
						blueprint: OsBlueprintWithVisibilitySchema,
						/** The copied revision (revision 1 of the new blueprint). */
						revision: OsBlueprintRevisionSchema,
						/** The dependency resolution recorded on the workspace. */
						preflight: OsBlueprintPreflightSchema,
						resources: z.array(OsWorkspaceResourceSchema),
						gadgets: z.array(
							z.object({
								gadget: OsGadgetSchema,
								revision: OsGadgetRevisionSchema,
							}),
						),
					}),
				),
		}),
	});
