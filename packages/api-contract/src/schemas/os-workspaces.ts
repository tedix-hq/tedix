/**
 * Tedix OS workspace domain wire schemas.
 *
 * D1 is canonical: `os_workspaces`, `os_gadgets`, `os_gadget_revisions`,
 * `os_gadget_executions`, `os_outputs`, `os_output_revisions`,
 * `os_blueprints`, and `os_blueprint_revisions` back these shapes. All ids are
 * caller/router-generated UUIDs and all timestamps are ISO-8601 text. Revision
 * bodies (`manifest`, `definition`, `content`) persist as JSON text columns;
 * these schemas define their structured wire form — applications serialize at
 * the D1 boundary.
 *
 * This is the from-scratch OS domain: it has no relationship to the
 * bridge tables in `packages/db/src/schema/os-instances.ts` or the Workshop
 * projections in `contracts/os-instances.ts`.
 */

import * as z from "zod";
import { FactoryBlueprintSchema } from "./factory-blueprints";
import { type JsonValue, JsonValueSchema } from "./common";
import { ModelRefSchema } from "./model-catalog";
import {
	ExecutionPreflightPinSchema,
	WorkItemCapabilityConnectionRefSchema,
	WorkItemExecutionPreflightDecisionSchema,
} from "./work-items";

/** Principal kind recorded on every Tedix OS row for accountability. */
export const OsCreatedByKindSchema = z.enum([
	"user",
	"tedi",
	"external_agent",
	"service",
]);

/** Lowercase sha-256 hex digest. */
const Sha256HexSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "expected a lowercase sha-256 hex digest");

export const OsWorkspaceStatusSchema = z.enum(["active", "archived"]);

export const OsWorkspaceProjectStatusSchema = z.enum(["active", "removed"]);

/** A Workspace-scoped reference to one canonical Work project. */
export const OsWorkspaceProjectSchema = z
	.object({
		id: z.string().uuid(),
		organizationId: z.string(),
		workspaceId: z.string().uuid(),
		projectId: z.string().uuid(),
		status: OsWorkspaceProjectStatusSchema,
		createdByKind: OsCreatedByKindSchema,
		createdById: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		removedAt: z
			.string()
			.nullable()
			.describe("Removal timestamp; null while the project link is active"),
	})
	.strict();
export type OsWorkspaceProject = z.infer<typeof OsWorkspaceProjectSchema>;

/** Lifecycle of a non-secret external resource reference attached to a Workspace. */
export const OsWorkspaceResourceStatusSchema = z.enum(["active", "removed"]);

export const OsWorkspaceResourceAvailabilitySchema = z
	.object({
		status: z.enum([
			"available",
			"missing_connection",
			"expired_connection",
			"check_failed",
			"not_executable",
		]),
		reason: z
			.string()
			.max(300)
			.nullable()
			.describe(
				"Null when available; otherwise a secret-free operator explanation for the blocked state",
			),
		checkedAt: z.string(),
	})
	.strict()
	.describe(
		"Secret-free, point-in-time projection of the canonical MCP connection backing this reference",
	);

const OsWorkspaceResourceMetadataKeySchema = z
	.string()
	.max(200)
	.refine(
		(key) => !/(?:token|secret|password|api[_-]?key|credential)/i.test(key),
		"Workspace resource metadata cannot contain credential-like fields",
	);

/**
 * One concrete provider object selected for a Workspace.
 *
 * This is deliberately a reference, never a credential container. The MCP
 * connection/token vault remains authoritative for authorization and secrets;
 * this record only names which external object is relevant to the Workspace.
 */
export const OsWorkspaceResourceSchema = z
	.object({
		id: z.string().uuid(),
		organizationId: z.string(),
		workspaceId: z.string().uuid(),
		slot: z
			.string()
			.trim()
			.min(1)
			.max(120)
			.nullable()
			.describe(
				"Named Blueprint slot; null for a resource attached manually outside Blueprint installation",
			),
		providerId: z.string().trim().min(1).max(160),
		connectionScope: z.enum(["tenant", "user"]),
		personalOwnerUserId: z.string().min(1).nullable().default(null),
		connectionInstanceId: z.string().uuid().nullable().default(null),
		requiredScopes: z
			.array(z.string().trim().min(1).max(300))
			.max(50)
			.default([]),
		resourceType: z.string().trim().min(1).max(160),
		providerResourceId: z.string().trim().min(1).max(1000),
		name: z.string().trim().min(1).max(200),
		metadata: z
			.record(OsWorkspaceResourceMetadataKeySchema, JsonValueSchema)
			.default({})
			.describe(
				"Bounded display/discovery metadata only; credentials and provider secrets are forbidden",
			),
		status: OsWorkspaceResourceStatusSchema,
		availability: OsWorkspaceResourceAvailabilitySchema.optional().describe(
			"Present when canonical connection availability has been checked for this response; omitted from unenriched resource references, including blueprint materialization results",
		),
		createdByKind: OsCreatedByKindSchema,
		createdById: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		removedAt: z
			.string()
			.nullable()
			.describe("Null while active; set when removal revoked Workspace use"),
	})
	.strict();
export type OsWorkspaceResource = z.infer<typeof OsWorkspaceResourceSchema>;

/** Page-bounded text read from an exact Workspace-bound provider PDF. */
export const OsWorkspacePdfReadSchema = z.object({
	resourceId: z.string().uuid(),
	providerResourceId: z.string(),
	fileName: z.string(),
	mimeType: z.literal("application/pdf"),
	modifiedTime: z
		.string()
		.nullable()
		.describe("Null when Google Drive did not return a modification time."),
	version: z
		.string()
		.nullable()
		.describe("Null when Google Drive did not return a revision number."),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	sizeBytes: z.number().int().nonnegative(),
	totalPages: z.number().int().positive(),
	pages: z.array(
		z.object({
			page: z.number().int().positive(),
			text: z.string(),
			truncated: z.boolean(),
			nextCharOffset: z
				.number()
				.int()
				.nonnegative()
				.nullable()
				.describe("Null when the entire page window has been returned."),
		}),
	),
	hasMorePages: z.boolean(),
});
export type OsWorkspacePdfRead = z.infer<typeof OsWorkspacePdfReadSchema>;

/** Input used after provider discovery selects one concrete external object. */
export const OsWorkspaceResourceSelectionSchema = z
	.object({
		providerId: z.string().trim().min(1).max(160),
		connectionScope: z.enum(["tenant", "user"]),
		connectionInstanceId: z.string().uuid().optional(),
		requiredScopes: z
			.array(z.string().trim().min(1).max(300))
			.max(50)
			.default([]),
		resourceType: z.string().trim().min(1).max(160),
		providerResourceId: z.string().trim().min(1).max(1000),
		name: z.string().trim().min(1).max(200),
		metadata: z
			.record(OsWorkspaceResourceMetadataKeySchema, JsonValueSchema)
			.default({}),
	})
	.strict()
	.refine(
		(value) =>
			value.connectionScope !== "user" || Boolean(value.connectionInstanceId),
		{
			message: "Select the exact personal account",
			path: ["connectionInstanceId"],
		},
	);
export type OsWorkspaceResourceSelection = z.infer<
	typeof OsWorkspaceResourceSelectionSchema
>;

export const OsWorkspaceResourceSlotSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[a-z][a-z0-9_]*$/, "Resource slots use lower snake_case");

export const OsBlueprintResourceRequirementSchema = z
	.object({
		slot: OsWorkspaceResourceSlotSchema,
		providerId: z.string().trim().min(1).max(160),
		tokenScope: z.enum(["tenant", "user", "either"]).default("either"),
		scopes: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
		resourceType: z.string().trim().min(1).max(160),
		label: z.string().trim().min(1).max(200),
	})
	.strict();

export const OsBlueprintResourceBindingSchema = z
	.object({
		slot: OsWorkspaceResourceSlotSchema,
		selection: OsWorkspaceResourceSelectionSchema,
	})
	.strict();
export type OsBlueprintResourceBinding = z.infer<
	typeof OsBlueprintResourceBindingSchema
>;

export const OsGadgetResourceGrantSchema = z
	.object({
		slot: OsWorkspaceResourceSlotSchema,
		operations: z
			.array(z.string().trim().min(1).max(160))
			.min(1)
			.max(50)
			.refine((values) => new Set(values).size === values.length, {
				message: "Resource grant operations must be unique",
			}),
	})
	.strict();

export const OsGadgetContextEnvelopeSchema = z
	.object({
		version: z.literal(1),
		organizationId: z.string(),
		workspace: z
			.object({ id: z.string().uuid(), name: z.string().max(200) })
			.strict(),
		gadget: z
			.object({
				id: z.string().uuid(),
				name: z.string().max(200),
				revisionId: z.string().uuid(),
				revision: z.number().int().positive(),
			})
			.strict(),
		resources: z
			.array(
				z
					.object({
						slot: OsWorkspaceResourceSlotSchema,
						providerId: z.string().max(160),
						resourceType: z.string().max(160),
						providerResourceId: z.string().max(1000),
						name: z.string().max(200),
						operations: z.array(z.string().max(160)).max(50),
					})
					.strict(),
			)
			.max(25),
	})
	.strict()
	.describe(
		"Host-assembled, secret-free context passed to one Gadget run; it contains only the current organization/workspace identity and resources explicitly granted by the pinned manifest",
	);
export type OsGadgetContextEnvelope = z.infer<
	typeof OsGadgetContextEnvelopeSchema
>;

/**
 * Personal presentation metadata for a workspace. The workspace row remains
 * the tenant authority; this projection never changes membership or lifecycle.
 */
export const OsWorkspacePreferenceSchema = z.object({
	workspaceId: z.string().uuid(),
	favorite: z.boolean(),
	lastOpenedAt: z
		.string()
		.datetime()
		.nullable()
		.describe("Null until the user first opens this workspace"),
	updatedAt: z.string(),
});

export const OsGadgetStatusSchema = z.enum(["active", "archived"]);

export const OsBlueprintStatusSchema = z.enum([
	"draft",
	"published",
	"archived",
]);

/** A Tedix OS workspace: the org-scoped container for gadgets. */
export const OsWorkspaceSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Optional operator-facing summary; null when never set"),
	status: OsWorkspaceStatusSchema,
	sourceBlueprintId: z
		.string()
		.nullable()
		.describe(
			"Instantiation provenance: the blueprint this workspace was created from (no FK — survives blueprint deletion); null for hand-created workspaces",
		),
	sourceBlueprintRevisionId: z
		.string()
		.nullable()
		.describe(
			"The exact blueprint revision the instantiation pinned; null for hand-created workspaces",
		),
	sourceBlueprintRevisionNumber: z
		.number()
		.int()
		.positive()
		.nullable()
		.describe(
			"The pinned revision's per-blueprint counter, so provenance reads without a second query; null for hand-created workspaces",
		),
	// Declared lazily: the preflight envelope, the rollback reference, and the
	// upgrade decision are all defined further down this file (they depend on the
	// blueprint requirement schemas). These are the module's only forward
	// references.
	instantiationPreflight: z
		.lazy(() => OsBlueprintPreflightSchema)
		.nullable()
		.describe(
			"Dependency resolution recorded at instantiation. Skills and policy packs move in place, so this evidence is not reconstructible later; null for hand-created workspaces",
		),
	rollbackReference: z
		.lazy(() => OsWorkspaceRollbackReferenceSchema)
		.nullable()
		.describe(
			"The blueprint revision an applied upgrade would return to, with the evidence recorded while it was pinned; null until an upgrade is applied",
		),
	blueprintDecision: z
		.lazy(() => OsWorkspaceBlueprintDecisionSchema)
		.nullable()
		.describe(
			"The last recorded apply-or-stay-pinned review. Null means nobody has reviewed an upgrade — which is NOT the same as a recorded decision to stay",
		),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/**
 * The declared shape of one gadget revision: capabilities it needs, the entry
 * point that serves it, the governed skill it dispatches, and free-form
 * authoring notes. Persisted as the JSON text `os_gadget_revisions.manifest`.
 */
export const OsGadgetExportDescriptorSchema = z
	.object({
		version: z.literal(1),
		id: z
			.string()
			.regex(/^[a-z][a-z0-9_-]{0,63}$/)
			.describe("Stable identifier selected by the download action"),
		label: z.string().min(1).max(80),
		artifactPath: z
			.string()
			.regex(/^outputs\/[A-Za-z0-9._~-]{1,200}\.json$/)
			.describe(
				"Run-relative output artifact whose step value contains bytesBase64Encoded and mimeType",
			),
		mimeType: z
			.string()
			.regex(
				/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i,
			)
			.describe(
				"Exact media type the declared artifact must report before a download URL is minted",
			),
		extension: z
			.string()
			.regex(/^[a-z0-9]{1,16}$/)
			.describe("Lowercase filename extension without a leading dot"),
	})
	.strict();

export const OsGadgetManifestSchema = z
	.object({
		capabilities: z.array(z.string().min(1).max(200)).max(100).default([]),
		resourceGrants: z
			.array(OsGadgetResourceGrantSchema)
			.max(25)
			.optional()
			.describe(
				"Named least-authority resource grants; absent on Gadget revisions recorded before resource grants existed",
			),
		entry: z
			.string()
			.min(1)
			.max(512)
			.describe(
				"Display/authoring hint for the surface that serves the gadget. Execution never loads this: when skillSlug is absent, entry selects the governed skill only if it matches a skill slug shape",
			),
		skillSlug: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Slug of the governed skill this gadget dispatches through skill-runtime; falls back to entry when entry matches a skill slug shape",
			),
		exports: z
			.array(OsGadgetExportDescriptorSchema)
			.max(10)
			.optional()
			.describe(
				"Versioned, allowlisted download formats produced by the governed skill run; absent on Gadget revisions with no custom exports",
			),
		notes: z
			.string()
			.max(10_000)
			.optional()
			.describe(
				"Free-form authoring notes; omitted when the author added none",
			),
	})
	.refine(
		(value) =>
			new Set((value.resourceGrants ?? []).map((grant) => grant.slot)).size ===
			(value.resourceGrants ?? []).length,
		{
			path: ["resourceGrants"],
			message: "Resource grant slots must be unique",
		},
	)
	.refine(
		(value) =>
			new Set((value.exports ?? []).map((descriptor) => descriptor.id)).size ===
			(value.exports ?? []).length,
		{
			path: ["exports"],
			message: "Gadget export ids must be unique",
		},
	);

/** A Tedix OS gadget: a versioned unit of workspace capability. */
export const OsGadgetSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Optional operator-facing summary; null when never set"),
	status: OsGadgetStatusSchema,
	currentRevisionId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"Latest revision id, maintained by the revision write batch (plain text, no FK); null until the first revision is recorded",
		),
	sourceBlueprintRevisionId: z
		.string()
		.nullable()
		.describe(
			"Per-gadget lineage: the exact blueprint revision whose definition declared this gadget; null for hand-created gadgets",
		),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/** One immutable gadget revision; `revision` is a per-gadget 1-based counter. */
export const OsGadgetRevisionSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	gadgetId: z.string().uuid(),
	revision: z.number().int().positive(),
	manifest: OsGadgetManifestSchema,
	sourceArtifactRef: z
		.string()
		.nullable()
		.describe(
			"Reference to the built artifact this revision was recorded from; null for manifest-only revisions",
		),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
});

export const OsGadgetExecutionStatusSchema = z.enum([
	"denied",
	"queued",
	"awaiting_approval",
	"running",
	"paused",
	"completed",
	"failed",
	"canceled",
]);

/**
 * The admission decision recorded on every execution receipt. New dispatches
 * carry the full capability/policy preflight decision trail. The decisions
 * field remains optional so immutable receipts written before governed-only
 * dispatch stay readable as historical evidence.
 */
export const OsGadgetExecutionPolicyDecisionSchema = z.object({
	allowed: z.boolean(),
	reasons: z
		.array(z.string().min(1).max(500))
		.max(20)
		.default([])
		.describe("Denial reasons; empty when the execution was admitted"),
	decisions: z
		.array(WorkItemExecutionPreflightDecisionSchema)
		.max(100)
		.optional()
		.describe(
			"Per-subject preflight decisions resolved for a governed tedi-executed run; absent only on historical receipts created before governed-only dispatch",
		),
});

/**
 * Dispatch lineage of a governed receipt. A parked approval has no runId until
 * it is approved and dispatched; historical pre-governance receipts may also
 * have null lineage. New terminal receipts always settle from runtime evidence.
 */
export const OsGadgetExecutionLineageSchema = z.object({
	runId: z
		.string()
		.nullable()
		.describe(
			"Dispatched skill run id; null while awaiting approval or on immutable historical pre-governance receipts",
		),
	workflowInstanceId: z
		.string()
		.nullable()
		.describe("Engine workflow instance backing the dispatched run"),
	tediId: z
		.string()
		.nullable()
		.describe("The tedi the governed run executes as"),
	workItemId: z
		.string()
		.nullable()
		.describe("Work Item admitted with the run, when the caller linked one"),
	traceBundleId: z
		.string()
		.nullable()
		.describe("Evidence/trace bundle reference recorded by runtime settlement"),
	billingReservationId: z
		.string()
		.nullable()
		.describe("Billing reservation taken at dispatch admission"),
	approvalRequestId: z
		.string()
		.nullable()
		.describe("Approval request parked on an awaiting_approval receipt"),
	runtimeEnvironment: z
		.string()
		.nullable()
		.describe("Deploy environment that admitted the dispatch"),
	agentSessionId: z
		.string()
		.nullable()
		.describe("External-agent session that started the run, when attested"),
	executionEpoch: z
		.number()
		.int()
		.nonnegative()
		.describe("Mirror of the dispatched run's execution epoch at admission"),
});

/**
 * One governed Gadget execution receipt, backed by `os_gadget_executions`.
 * Receipts are audit evidence: they carry no FK to the gadget and survive its
 * deletion. `revisionId`/`revision` pin exactly what was admitted to run;
 * `lineage` pins the dispatched skill run when the receipt is governed.
 */
export const OsGadgetExecutionSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	workspaceId: z.string().uuid(),
	gadgetId: z.string().uuid(),
	revisionId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"Pinned revision id; null when admission was denied before any revision existed",
		),
	revision: z
		.number()
		.int()
		.positive()
		.nullable()
		.describe("Pinned per-gadget revision number matching revisionId"),
	status: OsGadgetExecutionStatusSchema,
	grantedCapabilities: z
		.array(z.string())
		.describe("The explicit capability set granted at admission"),
	policyDecision: OsGadgetExecutionPolicyDecisionSchema,
	input: JsonValueSchema.nullable().describe(
		"Caller-supplied execution input; null when none was given",
	),
	output: JsonValueSchema.nullable().describe(
		"Runtime-reported output recorded at terminal settlement",
	),
	error: z
		.string()
		.nullable()
		.describe(
			"Failure detail recorded at completion; null unless the run failed",
		),
	costs: JsonValueSchema.nullable().describe(
		"Runtime-reported cost summary recorded at terminal settlement",
	),
	evidenceRefs: z
		.array(z.string())
		.nullable()
		.describe("Artifact/evidence references recorded from runtime evidence"),
	lineage: OsGadgetExecutionLineageSchema,
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	completedAt: z
		.string()
		.nullable()
		.describe("Set when the receipt settled; null while running or denied"),
});

export const OsOutputKindSchema = z.enum([
	"document",
	"sheet",
	"presentation",
	"video",
]);

export const OsOutputStatusSchema = z.enum(["active", "archived"]);

/**
 * The file formats an output revision can be exported as.
 *
 * `pdf` and `png` are renderings — the output is laid out as HTML and printed
 * or photographed, so they apply to every kind. The three Office formats are
 * generated from the content model itself and are therefore kind-specific: a
 * spreadsheet becomes a workbook with its cells and formulas, not a picture of
 * one, and there is no meaningful `.xlsx` of a slide deck.
 */
export const OsOutputExportFormatSchema = z.enum([
	"pdf",
	"png",
	"xlsx",
	"docx",
	"pptx",
]);

/**
 * Which output kinds each export format applies to. Shared by the router,
 * which refuses an inapplicable format, and by the OS, which only offers the
 * applicable ones — one table, so the UI can never show a button the server
 * rejects.
 */
export const OS_OUTPUT_EXPORT_FORMAT_KINDS = {
	pdf: ["document", "sheet", "presentation", "video"],
	png: ["document", "sheet", "presentation", "video"],
	xlsx: ["sheet"],
	docx: ["document"],
	pptx: ["presentation"],
} as const satisfies Record<
	z.infer<typeof OsOutputExportFormatSchema>,
	readonly OsOutputKind[]
>;

/** The export formats offered for one output kind, in presentation order. */
export function osOutputExportFormatsForKind(
	kind: OsOutputKind,
): Array<z.infer<typeof OsOutputExportFormatSchema>> {
	return OsOutputExportFormatSchema.options.filter((format) =>
		(OS_OUTPUT_EXPORT_FORMAT_KINDS[format] as readonly OsOutputKind[]).includes(
			kind,
		),
	);
}

/** One semantic block of a OS document output. */
export const OsDocumentBlockSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("heading"),
		level: z.number().int().min(1).max(4),
		text: z.string().max(2_000),
	}),
	z.object({ type: z.literal("paragraph"), text: z.string().max(20_000) }),
	z.object({
		type: z.literal("list"),
		ordered: z.boolean().default(false),
		items: z.array(z.string().max(2_000)).max(200),
	}),
	z.object({
		type: z.literal("code"),
		language: z
			.string()
			.max(60)
			.optional()
			.describe("Display-hint language tag; omitted for plain code"),
		text: z.string().max(40_000),
	}),
	z.object({ type: z.literal("quote"), text: z.string().max(20_000) }),
]);

export const OsSheetCellSchema = z.union([
	z.string().max(4_000),
	z.number(),
	z.boolean(),
	z.null(),
]);

/**
 * Tiptap-compatible rich-text JSON. The OS document editor persists this
 * alongside `blocks`: rich text owns the interactive round-trip while blocks
 * stay the stable semantic/headless projection used by patchDocument.
 */
export interface OsRichTextNode {
	type: string;
	attrs?: Record<string, JsonValue>;
	marks?: Array<{ type: string; attrs?: Record<string, JsonValue> }>;
	text?: string;
	content?: OsRichTextNode[];
}

const OsRichTextMarkSchema = z.object({
	type: z.string().min(1).max(80),
	attrs: z
		.record(z.string(), JsonValueSchema)
		.optional()
		.describe(
			"Mark-specific attributes; omitted when the mark has no parameters",
		),
});

export const OsRichTextNodeSchema: z.ZodType<OsRichTextNode> = z.lazy(() =>
	z.object({
		type: z.string().min(1).max(80),
		attrs: z
			.record(z.string(), JsonValueSchema)
			.optional()
			.describe(
				"Node-specific attributes; omitted for nodes with no parameters",
			),
		marks: z
			.array(OsRichTextMarkSchema)
			.max(32)
			.optional()
			.describe("Inline marks; omitted when text has no formatting"),
		text: z
			.string()
			.max(200_000)
			.optional()
			.describe("Text payload; omitted for structural nodes"),
		content: z
			.array(OsRichTextNodeSchema)
			.max(10_000)
			.optional()
			.describe("Child nodes; omitted for leaf nodes"),
	}),
);

export const OsRichTextDocumentSchema = z.object({
	type: z.literal("doc"),
	content: z.array(OsRichTextNodeSchema).max(10_000).default([]),
});

export const OsWorkbookCellFormatSchema = z.object({
	bold: z
		.boolean()
		.optional()
		.describe("Bold override; omitted for normal weight"),
	italic: z
		.boolean()
		.optional()
		.describe("Italic override; omitted for roman text"),
	underline: z
		.boolean()
		.optional()
		.describe("Underline override; omitted when off"),
	strike: z.boolean().optional().describe("Strike override; omitted when off"),
	textColor: z
		.string()
		.max(32)
		.optional()
		.describe("Text color override; omitted for the theme default"),
	fillColor: z
		.string()
		.max(32)
		.optional()
		.describe("Cell fill override; omitted for a transparent cell"),
	horizontalAlign: z
		.enum(["left", "center", "right"])
		.optional()
		.describe(
			"Horizontal alignment override; omitted for type-aware alignment",
		),
	wrap: z
		.boolean()
		.optional()
		.describe("Text wrapping override; omitted when wrapping is off"),
	numberFormat: z
		.enum([
			"automatic",
			"number",
			"currency",
			"percent",
			"scientific",
			"date",
			"time",
		])
		.optional()
		.describe("Number presentation override; omitted for automatic formatting"),
});

export const OsWorkbookCellSchema = z.object({
	/** User-authored literal or formula beginning with `=`. */
	input: z.string().max(4_000).default(""),
	/** Deterministic cached display value; recalculated by editors after writes. */
	value: OsSheetCellSchema.default(null),
	format: OsWorkbookCellFormatSchema.optional().describe(
		"Cell-local visual formatting; omitted when the workbook defaults apply",
	),
});

export const OsWorkbookColumnSchema = z.object({
	id: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	width: z.number().int().min(48).max(600).default(120),
});

export const OsWorkbookSheetSchema = z.object({
	id: z.string().min(1).max(80),
	name: z.string().min(1).max(120),
	columns: z.array(OsWorkbookColumnSchema).min(1).max(64),
	rows: z.array(z.array(OsWorkbookCellSchema.nullable()).max(64)).max(1_000),
	frozenRows: z.number().int().min(0).max(1_000).default(0),
	frozenColumns: z.number().int().min(0).max(64).default(0),
});

export const OsWorkbookSchema = z.object({
	activeSheetId: z.string().min(1).max(80),
	sheets: z.array(OsWorkbookSheetSchema).min(1).max(32),
});

export const OsPresentationElementTypeSchema = z.enum([
	"title",
	"subtitle",
	"text",
	"bullet",
	"label",
	"card",
	"box",
	"image",
	"svg",
	"divider",
	"shape",
	"arrow",
]);

export const OsPresentationElementSchema = z.object({
	id: z.string().min(1).max(80),
	type: OsPresentationElementTypeSchema,
	x: z.number().min(0).max(1_200),
	y: z.number().min(0).max(675),
	width: z.number().min(8).max(1_200),
	height: z.number().min(8).max(675),
	text: z
		.string()
		.max(20_000)
		.optional()
		.describe(
			"Visible or accessible text; omitted for purely graphical elements",
		),
	src: z
		.string()
		.max(1_500_000)
		.optional()
		.describe("Image source; omitted for non-image elements"),
	style: z
		.object({
			fontFamily: z
				.string()
				.max(120)
				.optional()
				.describe("Font override; omitted for the presentation default"),
			fontSize: z
				.number()
				.min(8)
				.max(180)
				.optional()
				.describe("Font size override; omitted for the element-type default"),
			fontWeight: z
				.enum(["normal", "medium", "semibold", "bold"])
				.optional()
				.describe("Font weight override; omitted for the element-type default"),
			color: z
				.string()
				.max(32)
				.optional()
				.describe("Foreground color override; omitted for the slide default"),
			background: z
				.string()
				.max(32)
				.optional()
				.describe("Element background override; omitted for transparent"),
			borderColor: z
				.string()
				.max(32)
				.optional()
				.describe("Border color override; omitted when no border is drawn"),
			borderWidth: z
				.number()
				.min(0)
				.max(24)
				.optional()
				.describe("Border width override; omitted when no border is drawn"),
			borderRadius: z
				.number()
				.min(0)
				.max(200)
				.optional()
				.describe("Corner radius override; omitted for square corners"),
			textAlign: z
				.enum(["left", "center", "right"])
				.optional()
				.describe("Text alignment override; omitted for left alignment"),
			opacity: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Element opacity override; omitted for fully opaque"),
			rotation: z
				.number()
				.min(-360)
				.max(360)
				.optional()
				.describe("Rotation in degrees; omitted for no rotation"),
		})
		.default({}),
});

export const OsPresentationCanvasSlideSchema = z.object({
	id: z.string().min(1).max(80),
	name: z.string().min(1).max(200),
	layout: z
		.enum(["blank", "title", "title-content", "two-column", "four-card"])
		.default("blank"),
	background: z.string().max(32).default("#ffffff"),
	elements: z.array(OsPresentationElementSchema).max(300).default([]),
	notes: z
		.string()
		.max(10_000)
		.optional()
		.describe("Speaker notes; omitted when the author added none"),
});

export const OsPresentationDeckSchema = z.object({
	width: z.literal(1_200).default(1_200),
	height: z.literal(675).default(675),
	activeSlideId: z.string().min(1).max(80),
	slides: z.array(OsPresentationCanvasSlideSchema).max(200),
});

/**
 * The outline payload of one slide patch operation: a title, its bullets, and
 * optional speaker notes.
 *
 * Deliberately the SEMANTIC shape rather than the visual canvas slide. A canvas
 * slide carries up to 300 positioned elements, and a tool schema that large is
 * exactly what made `outputs.create` unusable from a chat turn — a model emits
 * the scalars and drops the field it cannot hold. The router builds the canvas
 * slide from this outline and keeps the deck and its projection consistent, so
 * an agent describes a slide and the platform lays it out.
 */
export const OsPresentationSlideOutlineSchema = z.object({
	title: z.string().min(1).max(300),
	bullets: z.array(z.string().max(2_000)).max(30).default([]),
	notes: z
		.string()
		.max(10_000)
		.optional()
		.describe(
			"Speaker notes; omitted when the caller has none to set, matching OsPresentationSlideSchema. A replace that omits it clears the slide notes.",
		),
});

/**
 * One patch operation over a presentation output's slide list. Operations
 * apply in order against the evolving list: `insert` accepts indices
 * 0..length (appending at length); `replace`, `delete` and `move` require
 * existing indices.
 */
export const OsPresentationPatchOpSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("insert"),
		index: z.number().int().nonnegative(),
		slide: OsPresentationSlideOutlineSchema,
	}),
	z.object({
		op: z.literal("replace"),
		index: z.number().int().nonnegative(),
		slide: OsPresentationSlideOutlineSchema,
	}),
	z.object({
		op: z.literal("delete"),
		index: z.number().int().nonnegative(),
	}),
	z.object({
		op: z.literal("move"),
		from: z.number().int().nonnegative(),
		to: z.number().int().nonnegative(),
	}),
]);

/**
 * One patch operation over a document output's block list. Operations apply
 * in order against the evolving list: `insert` accepts indices 0..length
 * (appending at length), `replace` and `delete` require an existing index.
 */
export const OsDocumentPatchOpSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("insert"),
		index: z.number().int().nonnegative(),
		block: OsDocumentBlockSchema,
	}),
	z.object({
		op: z.literal("replace"),
		index: z.number().int().nonnegative(),
		block: OsDocumentBlockSchema,
	}),
	z.object({
		op: z.literal("delete"),
		index: z.number().int().nonnegative(),
	}),
]);

/** One slide of a OS presentation output. */
export const OsPresentationSlideSchema = z.object({
	title: z.string().max(300),
	bullets: z.array(z.string().max(2_000)).max(30).default([]),
	notes: z
		.string()
		.max(10_000)
		.optional()
		.describe("Speaker notes; omitted when the author added none"),
});

/**
 * The semantic content body of one output revision, discriminated by the
 * output's kind — a document is typed blocks, a sheet is a bounded
 * columns-and-rows grid, a presentation is a slide outline. Persisted as the
 * JSON text `os_output_revisions.content`; the router refuses a body whose
 * `kind` does not match the output it revises.
 */
export const OsOutputContentSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("document"),
		blocks: z.array(OsDocumentBlockSchema).max(500),
		richText: OsRichTextDocumentSchema.optional().describe(
			"Rich interactive document body; blocks remain its semantic/headless projection",
		),
	}),
	z.object({
		kind: z.literal("sheet"),
		columns: z.array(z.string().min(1).max(200)).max(64),
		rows: z.array(z.array(OsSheetCellSchema).max(64)).max(1_000),
		workbook: OsWorkbookSchema.optional().describe(
			"Multi-sheet workbook state; columns/rows mirror the active sheet for compatibility",
		),
	}),
	z.object({
		kind: z.literal("presentation"),
		slides: z.array(OsPresentationSlideSchema).max(200),
		deck: OsPresentationDeckSchema.optional().describe(
			"Visual 1200x675 slide canvas; slides remain its semantic/headless projection",
		),
	}),
	z.object({
		kind: z.literal("video"),
		renderId: z
			.uuid()
			.describe(
				"Id of a completed historical video render, served through the authenticated media route",
			),
		mimeType: z.literal("video/mp4"),
		caption: z
			.string()
			.max(2_000)
			.optional()
			.describe("Optional human-readable context for the rendered video"),
		delivery: z
			.object({
				status: z.enum(["candidate", "approved", "rejected"]),
				verdict: z
					.enum(["pass", "revise", "reject"])
					.optional()
					.describe("Absent until an independent quality verdict exists"),
				score: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe(
						"Absent when the quality gate did not emit a numeric score",
					),
				productRef: z
					.string()
					.max(300)
					.optional()
					.describe(
						"Absent for video outputs that are not tied to one product SKU",
					),
			})
			.strict()
			.optional()
			.describe(
				"Explicit quality-gate state; only approved videos are official deliverables",
			),
	}),
]);

/** A Tedix OS output: a durable, revisioned deliverable. */
export const OsOutputSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	workspaceId: z
		.string()
		.nullable()
		.describe(
			"Optional workspace grouping context (no FK — outputs are durable deliverables that outlive workspace lifecycle); null for org-level outputs",
		),
	kind: OsOutputKindSchema,
	title: z.string(),
	status: OsOutputStatusSchema,
	currentRevisionId: z
		.string()
		.uuid()
		.describe(
			"Latest revision id, maintained by the revision write batch (plain text, no FK); always set — creation writes revision 1",
		),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/**
 * Which skill run authored an output revision. Carries no FK and is never
 * inferred from the caller principal: it is only ever the lineage the workflow
 * bridge forwarded. The referenced run or skill may have been pruned, so
 * readers must render an orphaned id gracefully.
 */
export const OsOutputProducerSchema = z.object({
	skillRunId: z.string(),
	skillId: z
		.string()
		.nullable()
		.describe("Owning skill; null when only the run id was forwarded"),
});

export const OsDerivedResourceAccessSchema = z
	.object({
		workspaceResourceId: z.string().uuid(),
		workspaceId: z.string().uuid(),
		providerId: z.string().trim().min(1).max(160),
		resourceType: z.string().trim().min(1).max(160),
		providerResourceId: z.string().trim().min(1).max(1000),
		connectionScope: z.literal("tenant"),
		requiredScopes: z.array(z.string().trim().min(1).max(300)).max(50),
		operations: z.array(z.string().trim().min(1).max(160)).max(50),
	})
	.strict();

/** Immutable, secret-free access requirements inherited by derived bytes. */
export const OsDerivedAccessEnvelopeSchema = z
	.object({
		version: z.literal(1),
		sources: z.array(OsDerivedResourceAccessSchema).max(25),
	})
	.strict();
export type OsDerivedAccessEnvelope = z.infer<
	typeof OsDerivedAccessEnvelopeSchema
>;

/** One immutable output revision; `revision` is a per-output 1-based counter. */
export const OsOutputRevisionSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	outputId: z.string().uuid(),
	revision: z.number().int().positive(),
	content: OsOutputContentSchema,
	note: z
		.string()
		.nullable()
		.describe(
			"Optional revision message describing the edit; null when none was given",
		),
	producedBy: OsOutputProducerSchema.nullable().describe(
		"Skill run that authored this revision; null for a human-authored revision and for every revision written before producer lineage was recorded",
	),
	accessEnvelope: OsDerivedAccessEnvelopeSchema.nullable().describe(
		"Immutable source-derived viewer requirements; null means legacy or unverifiable provenance and must fail closed when shared",
	),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
});

/** Compact, inert library previews. No rich HTML, formulas, or image sources are returned. */
export const OsOutputLibraryPreviewSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("unavailable"),
		reason: z.literal("source_access_unavailable"),
	}),
	z.object({
		kind: z.literal("document"),
		lines: z.array(z.string().max(240)).max(6),
		blockCount: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("sheet"),
		columns: z.array(z.string().max(80)).max(6),
		rows: z.array(z.array(OsSheetCellSchema).max(6)).max(5),
		rowCount: z.number().int().nonnegative(),
		columnCount: z.number().int().nonnegative(),
		sheetCount: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("presentation"),
		title: z.string().max(300),
		bullets: z.array(z.string().max(240)).max(4),
		slideCount: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("video"),
		mimeType: z.literal("video/mp4"),
		caption: z
			.string()
			.max(240)
			.optional()
			.describe("Omitted when the video output has no authored caption"),
		delivery: z
			.object({
				status: z.enum(["candidate", "approved", "rejected"]),
				verdict: z
					.enum(["pass", "revise", "reject"])
					.optional()
					.describe("Absent until an independent quality verdict exists"),
				score: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe(
						"Absent when the quality gate did not emit a numeric score",
					),
			})
			.strict()
			.optional()
			.describe(
				"Absent for legacy video outputs that predate explicit delivery-state publication",
			),
	}),
]);

/** One Outputs-library card with canonical provenance and a bounded visual preview. */
export const OsOutputLibraryItemSchema = z.object({
	output: OsOutputSchema,
	workspace: z
		.object({
			id: z.string().uuid(),
			name: z.string(),
			status: OsWorkspaceStatusSchema,
		})
		.nullable()
		.describe(
			"Grouping workspace when it still exists; archived workspaces remain visible and org-level outputs are null",
		),
	currentRevision: z.object({
		id: z.string().uuid(),
		revision: z.number().int().positive(),
		createdAt: z.string(),
	}),
	scope: z
		.enum(["mine", "organization"])
		.describe(
			"Caller-relative provenance derived from the canonical creator principal; organization means another authorized org principal created it",
		),
	preview: OsOutputLibraryPreviewSchema,
});

export const OsCollaborationDocumentTypeSchema = z.enum(["gadget", "output"]);
export const OsCollaborationProposalStatusSchema = z.enum([
	"open",
	"accepted",
	"rejected",
	"merged",
]);
export const OsCollaborationSourceKindSchema = z.enum([
	"chat",
	"run",
	"agent_session",
]);

/**
 * Durable review record for an agent-authored Canvas proposal. `content` is a
 * preview pinned to `baseRevisionId`; it is never canonical until `merge`
 * appends `resultRevisionId` through the ordinary immutable revision chain.
 */
export const OsCollaborationProposalSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	workspaceId: z.string().uuid(),
	documentType: OsCollaborationDocumentTypeSchema,
	documentId: z.string().uuid(),
	baseRevisionId: z.string().uuid(),
	baseRevision: z.number().int().positive(),
	status: OsCollaborationProposalStatusSchema,
	sourceKind: OsCollaborationSourceKindSchema,
	sourceId: z.string(),
	content: JsonValueSchema,
	sequence: z.number().int().nonnegative(),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	decisionRationale: z
		.string()
		.nullable()
		.describe(
			"Acceptance or rejection rationale; null while the proposal is open",
		),
	decisionEvidenceRefs: z.array(z.string()),
	decidedByKind: OsCreatedByKindSchema.nullable().describe(
		"Accountable decision principal kind; null while the proposal is open",
	),
	decidedById: z
		.string()
		.nullable()
		.describe(
			"Accountable decision principal id; null while the proposal is open",
		),
	decidedAt: z
		.string()
		.nullable()
		.describe("Decision timestamp; null while the proposal is open"),
	mergeRationale: z
		.string()
		.nullable()
		.describe("Immutable merge rationale; null until a merge succeeds"),
	mergeEvidenceRefs: z.array(z.string()),
	mergedByKind: OsCreatedByKindSchema.nullable().describe(
		"Accountable merge principal kind; null until a merge succeeds",
	),
	mergedById: z
		.string()
		.nullable()
		.describe("Accountable merge principal id; null until a merge succeeds"),
	mergedAt: z
		.string()
		.nullable()
		.describe("Immutable merge timestamp; null until a merge succeeds"),
	resultRevisionId: z
		.string()
		.uuid()
		.nullable()
		.describe("Appended immutable revision id; null until a merge succeeds"),
	resultRevision: z
		.number()
		.int()
		.positive()
		.nullable()
		.describe(
			"Appended immutable revision number; null until a merge succeeds",
		),
});
// =============================================================================
// FORK LINEAGE — origin identity that survives an unreachable source org
// =============================================================================

/** How a fork crossed the organization boundary. */
export const OsBlueprintForkChannelSchema = z.enum(["gallery", "export"]);
export type OsBlueprintForkChannel = z.infer<
	typeof OsBlueprintForkChannelSchema
>;

/**
 * One ancestor in a blueprint's fork chain: everything needed to NAME the
 * origin without a live read of the organization that authored it.
 *
 * `organizationId` and `organizationName` are the source's own identity as it
 * stood when the fork was taken — a display name is not stable across renames
 * and an id is not human-readable, so both are recorded and neither is
 * resolved later. `definitionSha256` is the content digest of the exact
 * definition that was forked (canonical JSON of the PARSED definition), which
 * is what makes an ancestor identifiable when its blueprint row is gone.
 *
 * This entry is strictly identity and provenance. It carries no principal id,
 * no requirements, and no definition body — the definition it names is stored
 * on the fork's own revision.
 */
export const OsBlueprintLineageEntrySchema = z
	.object({
		organizationId: z
			.string()
			.min(1)
			.max(200)
			.describe("The organization that owned the forked blueprint"),
		organizationName: z
			.string()
			.min(1)
			.max(200)
			.nullable()
			.describe(
				"That organization's display name when the fork was taken; null when the fork path could not read one",
			),
		blueprintId: z.string().uuid(),
		blueprintName: z.string().min(1).max(200),
		revisionId: z.string().uuid(),
		revision: z.number().int().positive(),
		definitionSha256: Sha256HexSchema.describe(
			"Digest of the canonical JSON of the forked revision's parsed definition",
		),
		forkedAt: z.string(),
		via: OsBlueprintForkChannelSchema,
		attested: z
			.boolean()
			.describe(
				"Whether the PLATFORM verified this ancestor, or the importer merely asserted it. True only for a gallery fork, where the server read the source rows itself. An `export` envelope is caller-supplied: its digest proves the envelope is self-consistent, NOT that the named organization ever published that revision — a tenant can name any org and any real ids. Never read an unattested entry as proof of origin.",
			),
	})
	.strict();
export type OsBlueprintLineageEntry = z.infer<
	typeof OsBlueprintLineageEntrySchema
>;

/** Deepest ancestry a lineage chain carries; older ancestors are dropped and flagged. */
export const OS_BLUEPRINT_LINEAGE_DEPTH = 20;

/**
 * A blueprint's fork ancestry, nearest ancestor first (`chain[0]` is the
 * blueprint this one was forked FROM). Recorded only by the fork paths — a
 * gallery import and an export/import round trip — never by `blueprints.revise`,
 * so it cannot be forged by a caller-supplied definition.
 */
export const OsBlueprintLineageSchema = z
	.object({
		version: z.literal(1),
		chain: z
			.array(OsBlueprintLineageEntrySchema)
			.min(1)
			.max(OS_BLUEPRINT_LINEAGE_DEPTH),
		truncated: z
			.boolean()
			.describe(
				`True when ancestry older than the ${OS_BLUEPRINT_LINEAGE_DEPTH}-entry cap was dropped`,
			),
	})
	.strict();
export type OsBlueprintLineage = z.infer<typeof OsBlueprintLineageSchema>;

/** A Tedix OS blueprint: an org-scoped, versioned workspace template. */
export const OsBlueprintSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Optional operator-facing summary; null when never set"),
	status: OsBlueprintStatusSchema,
	currentRevisionId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"Latest revision id, maintained by the revision write batch (plain text, no FK); null until the first revision is recorded",
		),
	lineage: OsBlueprintLineageSchema.nullable().describe(
		"Fork ancestry recorded when this blueprint was imported from another one; null for hand-authored blueprints",
	),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

// =============================================================================
// BLUEPRINT REQUIREMENTS — version-pinned, typed dependency declarations
// =============================================================================

/**
 * A version-pinned skill (or flow) dependency.
 *
 * `skillId` + `revision` is the pin. The slug alone is NOT a pin: `slug` is
 * unique per organization, so the same slug names a different skill in every
 * other tenant — a blueprint imported from the gallery that resolved by slug
 * would silently bind to a stranger's code. Preflight therefore resolves the
 * slug inside the caller's organization and then requires the resolved row's
 * id AND revision to equal the pin.
 *
 * `skill_entries.revision` is a mutable in-place counter with no revision
 * history table, so a revision pin is a DRIFT SIGNAL, not a restorable
 * reference: when the skill has moved past the pinned revision the requirement
 * resolves `incompatible` and the blueprint must be re-pinned. `workflowSha256`
 * is the only integrity-grade pin available (a digest over
 * `skill_entries.files["scripts/workflow.ts"]`, the same content-addressing the
 * skill-improvement governance path already uses).
 *
 * `role: "flow"` names the workflow surface rather than the document surface. A
 * flow is not a separate platform object — the workflow definition IS
 * `files["scripts/workflow.ts"]` — so a flow requirement must pin its digest.
 */
export const OsBlueprintSkillRequirementSchema = z
	.object({
		role: z.enum(["skill", "flow"]).default("skill"),
		skillId: z.string().uuid(),
		slug: z.string().min(1).max(200),
		revision: z.number().int().positive(),
		workflowSha256: Sha256HexSchema.nullable()
			.default(null)
			.describe(
				"Integrity pin over files['scripts/workflow.ts']; required when role is 'flow'",
			),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.role === "flow" && !value.workflowSha256) {
			ctx.addIssue({
				code: "custom",
				path: ["workflowSha256"],
				message:
					"a flow requirement must pin workflowSha256: a flow has no revision table of its own",
			});
		}
	});
export type OsBlueprintSkillRequirement = z.infer<
	typeof OsBlueprintSkillRequirementSchema
>;

/**
 * A version-pinned policy-pack constraint.
 *
 * `policy_packs` is unique on `(scope, slug)` GLOBALLY, so an org-scoped slug
 * is owned by exactly one tenant — a resolver that looked it up without an
 * `organization_id` predicate would read the OWNING tenant's private pack for
 * whoever imported the blueprint. Scope is part of the declaration and the
 * resolver binds the caller's organization for `scope: "organization"`.
 *
 * `policy_packs.version` is a mutable in-place counter (same caveat as skill
 * revisions), so a version mismatch resolves `incompatible`.
 */
export const OsBlueprintPolicyRequirementSchema = z
	.object({
		scope: z.enum(["system", "organization"]),
		slug: z.string().min(1).max(200),
		version: z.number().int().positive(),
	})
	.strict();
export type OsBlueprintPolicyRequirement = z.infer<
	typeof OsBlueprintPolicyRequirementSchema
>;

/**
 * Model/runtime compatibility the blueprint's gadgets need. Resolved against a
 * TARGET TEDI's runtime profile (`runtime_profiles.config.modelPolicy`), so a
 * blueprint declaring runtime requirements needs a `tediId` at preflight —
 * without one nothing can be resolved and the requirement stays `missing`
 * rather than being assumed satisfied.
 */
export const OsBlueprintRuntimeRequirementSchema = z
	.object({
		modelRef: ModelRefSchema.nullable()
			.default(null)
			.describe(
				"Exact `provider/model-id` the blueprint pins; null leaves the model open to the tier/reasoning constraints",
			),
		minTier: z
			.enum(["economy", "balanced", "frontier"])
			.nullable()
			.default(null)
			.describe("Lowest cognition-catalog tier that can serve this blueprint"),
		requiresReasoning: z.boolean().default(false),
	})
	.strict();
export type OsBlueprintRuntimeRequirement = z.infer<
	typeof OsBlueprintRuntimeRequirementSchema
>;

/** One gadget's placement on the blueprint's declared grid. */
export const OsBlueprintLayoutPlacementSchema = z
	.object({
		gadget: z
			.string()
			.min(1)
			.max(120)
			.describe("Name of a gadget the same revision declares"),
		column: z.number().int().min(1).max(12),
		row: z.number().int().min(1).max(64),
		width: z.number().int().min(1).max(12).default(1),
		height: z.number().int().min(1).max(64).default(1),
	})
	.strict();

/**
 * A checkable surface layout: a column grid plus non-overlapping placements
 * that must name gadgets the SAME revision declares. Replaces the previous
 * free-form `JsonValue` layout, which nothing could validate or render.
 */
export const OsBlueprintLayoutRequirementSchema = z
	.object({
		columns: z.number().int().min(1).max(12).default(12),
		placements: z.array(OsBlueprintLayoutPlacementSchema).max(100).default([]),
	})
	.strict();
export type OsBlueprintLayoutRequirement = z.infer<
	typeof OsBlueprintLayoutRequirementSchema
>;

/**
 * A deliverable the blueprint declares one of its gadgets produces. This is a
 * declaration, not a provisioning instruction: instantiation does NOT create
 * `os_outputs` rows. Preflight checks only what it can read — that the
 * producing gadget is declared by the same revision and that titles are unique.
 */
export const OsBlueprintOutputRequirementSchema = z
	.object({
		gadget: z
			.string()
			.min(1)
			.max(120)
			.describe("Name of the declared gadget that produces this output"),
		kind: OsOutputKindSchema,
		title: z.string().min(1).max(200),
	})
	.strict();
export type OsBlueprintOutputRequirement = z.infer<
	typeof OsBlueprintOutputRequirementSchema
>;

/**
 * The blueprint's complete typed dependency declaration. Every member is a
 * structured, resolvable reference — there are no free-form requirement
 * strings, and every object is `.strict()`, so a credential (an `accessToken`,
 * a `secret`, an api key) cannot be represented in a blueprint at all and can
 * never ride a gallery export across the tenant boundary.
 *
 * Connections deliberately reuse `WorkItemCapabilityConnectionRefSchema`
 * verbatim rather than inventing a second connection vocabulary: a connection
 * requirement is `(providerId, tokenScope, scopes)` and nothing else. There is
 * no version to pin — `connection_providers` carries none.
 */
export const OsBlueprintRequirementsSchema = z
	.object({
		version: z.literal(1),
		skills: z.array(OsBlueprintSkillRequirementSchema).max(100).default([]),
		connections: z
			.array(WorkItemCapabilityConnectionRefSchema)
			.max(25)
			.default([]),
		resources: z
			.array(OsBlueprintResourceRequirementSchema)
			.max(25)
			.optional()
			.describe(
				"Named concrete-resource slots; absent on Blueprint revisions recorded before resource selection existed",
			),
		policies: z.array(OsBlueprintPolicyRequirementSchema).max(25).default([]),
		runtime: OsBlueprintRuntimeRequirementSchema.nullable()
			.default(null)
			.describe(
				"Null when the blueprint places no model/runtime constraint; preflight then emits no `model` decision at all rather than claiming one was satisfied",
			),
		layout: OsBlueprintLayoutRequirementSchema.nullable()
			.default(null)
			.describe(
				"Null when the blueprint leaves surface layout to the instantiating workspace; preflight then emits no `layout` decision",
			),
		outputs: z.array(OsBlueprintOutputRequirementSchema).max(50).default([]),
	})
	.strict()
	.superRefine((value, ctx) => {
		const duplicate = (values: string[]) =>
			values.find((entry, index) => values.indexOf(entry) !== index);
		const duplicateSkill = duplicate(
			value.skills.map((skill) => `${skill.role}:${skill.slug}`),
		);
		if (duplicateSkill) {
			ctx.addIssue({
				code: "custom",
				path: ["skills"],
				message: `Duplicate skill requirement: ${duplicateSkill}`,
			});
		}
		const duplicatePolicy = duplicate(
			value.policies.map((policy) => `${policy.scope}:${policy.slug}`),
		);
		if (duplicatePolicy) {
			ctx.addIssue({
				code: "custom",
				path: ["policies"],
				message: `Duplicate policy requirement: ${duplicatePolicy}`,
			});
		}
		const duplicateConnection = duplicate(
			value.connections.map(
				(connection) => `${connection.providerId}:${connection.tokenScope}`,
			),
		);
		if (duplicateConnection) {
			ctx.addIssue({
				code: "custom",
				path: ["connections"],
				message: `Duplicate connection requirement: ${duplicateConnection}`,
			});
		}
		const duplicateResource = duplicate(
			(value.resources ?? []).map((resource) => resource.slot),
		);
		if (duplicateResource) {
			ctx.addIssue({
				code: "custom",
				path: ["resources"],
				message: `Duplicate resource slot: ${duplicateResource}`,
			});
		}
		const duplicateOutput = duplicate(
			value.outputs.map((output) => output.title),
		);
		if (duplicateOutput) {
			ctx.addIssue({
				code: "custom",
				path: ["outputs"],
				message: `Duplicate output title: ${duplicateOutput}`,
			});
		}
	});
export type OsBlueprintRequirements = z.infer<
	typeof OsBlueprintRequirementsSchema
>;

/**
 * The declared content of one blueprint revision: the gadgets it instantiates
 * plus its typed, version-pinned dependency declaration. Persisted as the JSON
 * text `os_blueprint_revisions.definition`.
 *
 * `requirements` is nullable: revisions written before pinned requirements
 * existed parse to `null`, which preflight reports as `not_configured` rather
 * than inventing satisfied dependencies for them.
 */
export const OsBlueprintDefinitionSchema = z.object({
	factory: FactoryBlueprintSchema.optional().describe(
		"Optional portable factory operating contract; installation never accepts Work, enables schedules, or grants authority",
	),
	gadgets: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				manifest: OsGadgetManifestSchema,
			}),
		)
		.max(100)
		.default([]),
	requirements: OsBlueprintRequirementsSchema.nullable()
		.default(null)
		.describe(
			"Version-pinned dependency declaration; null on revisions recorded before pinned requirements existed",
		),
});

/** One immutable blueprint revision; `revision` is a per-blueprint 1-based counter. */
export const OsBlueprintRevisionSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	blueprintId: z.string().uuid(),
	revision: z.number().int().positive(),
	definition: OsBlueprintDefinitionSchema,
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	publishedAt: z
		.string()
		.nullable()
		.describe("Set when this exact revision was published; null while draft"),
});

/**
 * Read-only resolution of one pinned blueprint revision's dependencies against
 * the CALLER's organization. It never mints authority and never provisions.
 *
 * `decisions` is the platform's single preflight vocabulary
 * ({@link WorkItemExecutionPreflightDecisionSchema}); the board's per-dependency
 * states map onto its verdicts exactly — `available` is `allowed`, and
 * `missing` / `denied` / `consent_required` / `incompatible` keep their names.
 * A decision is emitted only for a requirement the revision actually DECLARES,
 * so an absent kind means "nothing was declared", never "nothing was checked".
 *
 * Two severities, because they have different consequences:
 * - DEFINITIONAL dependencies (skill, policy_pack, model, layout, output) are
 *   what instantiation reproduces. If one cannot resolve to its exact pin the
 *   status is `blocked` and instantiation refuses.
 * - CONNECTIONS are runtime credentials. Instantiation never copies them, so a
 *   connection gap never blocks creating the workspace — it surfaces as
 *   `needs_consent` with the remediation the operator has to perform.
 */
export const OsBlueprintPreflightSchema = z.object({
	blueprintId: z.string().uuid(),
	revisionId: z.string().uuid(),
	revision: z.number().int().positive(),
	status: z
		.enum([
			"not_configured",
			"ready",
			"needs_consent",
			"needs_configuration",
			"blocked",
		])
		.describe(
			"`not_configured` when the revision declares no requirements at all; `blocked` when a definitional pin failed; `needs_consent` when only connections are unsatisfied",
		),
	instantiateAllowed: z.boolean().describe("True unless status is `blocked`"),
	targetTediId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"The tedi model/runtime compatibility was resolved against; null when the caller supplied none",
		),
	requirements: OsBlueprintRequirementsSchema.nullable().describe(
		"Exactly what the pinned revision declares; null on a pre-requirements revision",
	),
	decisions: z.array(WorkItemExecutionPreflightDecisionSchema).max(300),
	blockingReasons: z
		.array(z.string())
		.describe("Definitional failures that refuse instantiation"),
	consentReasons: z
		.array(z.string())
		.describe(
			"Connection gaps; recorded and surfaced, never a reason to refuse instantiation",
		),
	configurationReasons: z
		.array(z.string())
		.default([])
		.describe(
			"Missing or denied concrete resource selections that refuse instantiation",
		),
	resolvedAt: z.string(),
});
export type OsBlueprintPreflight = z.infer<typeof OsBlueprintPreflightSchema>;

// =============================================================================
// PORTABLE EXPORT ENVELOPE — a bounded projection, never a row spread
// =============================================================================

export const OS_BLUEPRINT_EXPORT_ENVELOPE_VERSION = 1;

/**
 * The complete, portable form of one blueprint revision.
 *
 * This is an EXPLICIT ALLOWLIST, not a projection of the row: every field below
 * is named, and everything else a blueprint touches is excluded by
 * construction —
 *
 * - `organizationId` of the exporting row and `createdById` of either row: a
 *   principal/tenant identifier, never presentation. Only `createdByKind`
 *   travels, and the origin's organization identity travels once, deliberately,
 *   inside `source` (that IS the lineage record).
 * - credentials: a connection requirement is `(providerId, tokenScope, scopes)`
 *   and every requirement object is `.strict()`, so no token can be represented.
 *   Import re-parses before persisting, so nothing outside the schema survives.
 * - storage refs: `sourceArtifactRef` and R2 export keys are per-tenant object
 *   references; the definition has no field for either.
 * - private artifacts, evidence, receipts, costs: `os_gadget_executions` in
 *   whole. Nothing in this envelope references an execution.
 * - output CONTENT: a blueprint declares `{gadget, kind, title}` and
 *   instantiation creates no `os_outputs` rows, so no body can travel.
 * - chat, memory, rationale: no reference exists from the blueprint domain.
 * - `instantiationPreflight`: org-specific resolution evidence that lives on a
 *   workspace, not a blueprint, and means nothing in another tenant.
 * - `visibility`: the source organization's catalog decision. Import always
 *   writes `org`, so an import can never republish someone else's blueprint.
 */
export const OsBlueprintExportSchema = z
	.object({
		envelopeVersion: z.literal(OS_BLUEPRINT_EXPORT_ENVELOPE_VERSION),
		exportedAt: z.string(),
		exportedByKind: OsCreatedByKindSchema.describe(
			"Principal KIND that exported; the principal's id is deliberately not carried",
		),
		source: OsBlueprintLineageEntrySchema.describe(
			"Identity of the exported blueprint revision — on import this becomes the head of the importing copy's lineage chain",
		),
		blueprint: z
			.object({
				name: z.string().min(1).max(200),
				description: z
					.string()
					.max(4000)
					.nullable()
					.describe(
						"The source blueprint's description; null when it carried none — a blueprint is never required to have one",
					),
				status: OsBlueprintStatusSchema.describe(
					"Lifecycle of the blueprint in the SOURCE organization; informational — an import always lands as `draft`",
				),
			})
			.strict(),
		revision: z
			.object({
				revision: z.number().int().positive(),
				createdAt: z.string(),
				publishedAt: z
					.string()
					.nullable()
					.describe(
						"When the source organization published this revision; null when it was still a draft there — an import lands as `draft` either way",
					),
				createdByKind: OsCreatedByKindSchema,
			})
			.strict(),
		definition: OsBlueprintDefinitionSchema,
		lineage: OsBlueprintLineageSchema.nullable().describe(
			"The exported blueprint's OWN ancestry, so a fork of a fork keeps its chain; null when the exported blueprint was hand-authored",
		),
	})
	.strict();
export type OsBlueprintExport = z.infer<typeof OsBlueprintExportSchema>;

// =============================================================================
// UPGRADE COMPATIBILITY — the same preflight vocabulary, diffed
// =============================================================================

const preflightKind = WorkItemExecutionPreflightDecisionSchema.shape.kind;
const preflightVerdict = WorkItemExecutionPreflightDecisionSchema.shape.verdict;

/**
 * One requirement's fate across a candidate upgrade, keyed by the preflight
 * vocabulary's `(kind, subject)` identity. There is no second comparison
 * vocabulary here: every verdict on this row came out of
 * {@link OsBlueprintPreflightSchema}.
 *
 * Three verdict columns, because two of them answer different questions:
 * `verdictAtInstantiation` is what the stored envelope recorded, `pinnedVerdict`
 * is what the SAME pinned declaration resolves to today, and `candidateVerdict`
 * is the candidate revision resolved today. Skills and policy packs version in
 * place, so a difference between the first two is TENANT DRIFT under an
 * unchanged pin — reporting it as an effect of the upgrade would be a lie.
 */
export const OsBlueprintRequirementChangeSchema = z
	.object({
		kind: preflightKind,
		subject: z.string().min(1).max(400),
		change: z
			.enum(["added", "removed", "repinned", "unchanged"])
			.describe(
				"Declaration-level diff: `repinned` means both revisions declare the subject with different declared pins",
			),
		verdictAtInstantiation: preflightVerdict
			.nullable()
			.describe(
				"Verdict recorded in the workspace's instantiation envelope; null when no envelope was stored or it never covered this subject",
			),
		pinnedVerdict: preflightVerdict
			.nullable()
			.describe(
				"The currently pinned revision's declaration resolved against this organization NOW; null when the pinned revision does not declare it",
			),
		candidateVerdict: preflightVerdict
			.nullable()
			.describe(
				"The candidate revision's declaration resolved against this organization NOW; null when the candidate drops it",
			),
		driftedSinceInstantiation: z
			.boolean()
			.describe(
				"True when pinnedVerdict differs from verdictAtInstantiation — drift under the unchanged pin, not an effect of the upgrade",
			),
		pinnedDeclaredPin: ExecutionPreflightPinSchema.nullable().describe(
			"The version the PINNED revision declares for this subject; null when the pinned revision does not declare it (the row is an `added` requirement) or declares it without a pin",
		),
		candidateDeclaredPin: ExecutionPreflightPinSchema.nullable().describe(
			"The version the CANDIDATE revision declares for this subject; null when the candidate drops it (the row is `removed`) or declares it without a pin",
		),
		candidateResolvedPin: ExecutionPreflightPinSchema.nullable().describe(
			"What actually resolved for the candidate from a real read; null when nothing resolved or the candidate drops the subject",
		),
		reason: z
			.string()
			.min(1)
			.max(2000)
			.describe(
				"Reason text of the decision this row reports: the candidate's when the candidate declares the subject, otherwise the pinned revision's",
			),
	})
	.strict();
export type OsBlueprintRequirementChange = z.infer<
	typeof OsBlueprintRequirementChangeSchema
>;

/** One declared gadget's fate across a candidate upgrade; `changed` means the manifest differs. */
export const OsBlueprintGadgetChangeSchema = z
	.object({
		name: z.string().min(1).max(120),
		change: z.enum(["added", "removed", "changed", "unchanged"]),
	})
	.strict();
export type OsBlueprintGadgetChange = z.infer<
	typeof OsBlueprintGadgetChangeSchema
>;

/**
 * The compatibility report behind an apply-or-stay-pinned decision: what the
 * candidate revision changes, and whether it resolves in THIS organization.
 * Every claim here is backed by a real read — three preflight resolutions and a
 * definition diff — so "compatible" never means "nothing was checked".
 */
export const OsBlueprintUpgradeReportSchema = z
	.object({
		workspaceId: z.string().uuid(),
		blueprintId: z.string().uuid(),
		pinnedRevisionId: z.string().uuid(),
		pinnedRevision: z.number().int().positive(),
		candidateRevisionId: z.string().uuid(),
		candidateRevision: z.number().int().positive(),
		upToDate: z
			.boolean()
			.describe("True when the candidate IS the currently pinned revision"),
		preflightAtInstantiation: OsBlueprintPreflightSchema.nullable().describe(
			"The envelope stored on the workspace; null when the row predates it or the stored JSON no longer parses",
		),
		pinnedPreflightNow: OsBlueprintPreflightSchema.describe(
			"The currently pinned revision re-resolved now — the drift baseline",
		),
		candidatePreflightNow: OsBlueprintPreflightSchema.describe(
			"The candidate revision resolved now; this is what an apply would record",
		),
		requirementChanges: z.array(OsBlueprintRequirementChangeSchema).max(500),
		gadgetChanges: z.array(OsBlueprintGadgetChangeSchema).max(200),
		applyAllowed: z
			.boolean()
			.describe(
				"Mirrors candidatePreflightNow.instantiateAllowed: false when a definitional pin fails, which refuses an apply",
			),
		blockingReasons: z.array(z.string()),
		consentReasons: z.array(z.string()),
		resolvedAt: z.string(),
	})
	.strict();
export type OsBlueprintUpgradeReport = z.infer<
	typeof OsBlueprintUpgradeReportSchema
>;

/** The bounded evidence summary persisted beside a decision; every count comes from the report that was actually resolved. */
export const OsBlueprintUpgradeDecisionSummarySchema = z
	.object({
		candidateStatus: OsBlueprintPreflightSchema.shape.status,
		applyAllowed: z.boolean(),
		requirementsChanged: z
			.number()
			.int()
			.nonnegative()
			.describe("Requirement rows whose change is not `unchanged`"),
		gadgetsAdded: z.number().int().nonnegative(),
		gadgetsChanged: z.number().int().nonnegative(),
		gadgetsRemoved: z.number().int().nonnegative(),
		blockingReasons: z.array(z.string().max(2000)).max(50),
		consentReasons: z.array(z.string().max(2000)).max(50),
		resolvedAt: z.string(),
	})
	.strict();
export type OsBlueprintUpgradeDecisionSummary = z.infer<
	typeof OsBlueprintUpgradeDecisionSummarySchema
>;

/**
 * The recorded outcome of one upgrade review. `stay_pinned` is a real, durable
 * decision — a reader can tell "we looked at revision N and chose not to move"
 * from "nobody looked", which the absence of an upgrade alone can never say.
 */
export const OsWorkspaceBlueprintDecisionSchema = z
	.object({
		version: z.literal(1),
		decision: z.enum(["applied", "stay_pinned"]),
		decidedAt: z.string(),
		decidedByKind: OsCreatedByKindSchema,
		reviewedRevisionId: z
			.string()
			.uuid()
			.describe("The candidate revision the operator reviewed"),
		reviewedRevision: z.number().int().positive(),
		pinnedRevisionId: z
			.string()
			.uuid()
			.describe("The revision the workspace is pinned to AFTER this decision"),
		pinnedRevision: z.number().int().positive(),
		reason: z
			.string()
			.max(2000)
			.nullable()
			.describe("Operator's stated reason; null when none was given"),
		summary: OsBlueprintUpgradeDecisionSummarySchema,
	})
	.strict();
export type OsWorkspaceBlueprintDecision = z.infer<
	typeof OsWorkspaceBlueprintDecisionSchema
>;

/** The revision an applied upgrade would return to, named by the workspace itself. */
export const OsWorkspaceRollbackReferenceSchema = z
	.object({
		revisionId: z.string().uuid(),
		revision: z.number().int().positive(),
		preflight: OsBlueprintPreflightSchema.nullable().describe(
			"The dependency evidence recorded while the workspace was pinned there; null when that pin carried none",
		),
	})
	.strict();
export type OsWorkspaceRollbackReference = z.infer<
	typeof OsWorkspaceRollbackReferenceSchema
>;

export type OsCreatedByKind = z.infer<typeof OsCreatedByKindSchema>;
export type OsGadgetExecutionStatus = z.infer<
	typeof OsGadgetExecutionStatusSchema
>;
export type OsGadgetExecutionPolicyDecision = z.infer<
	typeof OsGadgetExecutionPolicyDecisionSchema
>;
export type OsGadgetExecutionLineage = z.infer<
	typeof OsGadgetExecutionLineageSchema
>;
export type OsGadgetExecution = z.infer<typeof OsGadgetExecutionSchema>;
export type OsOutputKind = z.infer<typeof OsOutputKindSchema>;
export type OsOutputStatus = z.infer<typeof OsOutputStatusSchema>;
export type OsOutputExportFormat = z.infer<typeof OsOutputExportFormatSchema>;
export type OsDocumentBlock = z.infer<typeof OsDocumentBlockSchema>;
export type OsRichTextDocument = z.infer<typeof OsRichTextDocumentSchema>;
export type OsDocumentPatchOp = z.infer<typeof OsDocumentPatchOpSchema>;
export type OsSheetCell = z.infer<typeof OsSheetCellSchema>;
export type OsWorkbookCellFormat = z.infer<typeof OsWorkbookCellFormatSchema>;
export type OsWorkbookCell = z.infer<typeof OsWorkbookCellSchema>;
export type OsWorkbookColumn = z.infer<typeof OsWorkbookColumnSchema>;
export type OsWorkbookSheet = z.infer<typeof OsWorkbookSheetSchema>;
export type OsWorkbook = z.infer<typeof OsWorkbookSchema>;
export type OsPresentationSlide = z.infer<typeof OsPresentationSlideSchema>;
export type OsPresentationElementType = z.infer<
	typeof OsPresentationElementTypeSchema
>;
export type OsPresentationElement = z.infer<typeof OsPresentationElementSchema>;
export type OsPresentationCanvasSlide = z.infer<
	typeof OsPresentationCanvasSlideSchema
>;
export type OsPresentationDeck = z.infer<typeof OsPresentationDeckSchema>;
export type OsOutputContent = z.infer<typeof OsOutputContentSchema>;
export type OsOutput = z.infer<typeof OsOutputSchema>;
export type OsOutputRevision = z.infer<typeof OsOutputRevisionSchema>;
export type OsOutputLibraryPreview = z.infer<
	typeof OsOutputLibraryPreviewSchema
>;
export type OsOutputLibraryItem = z.infer<typeof OsOutputLibraryItemSchema>;
export type OsCollaborationDocumentType = z.infer<
	typeof OsCollaborationDocumentTypeSchema
>;
export type OsCollaborationProposalStatus = z.infer<
	typeof OsCollaborationProposalStatusSchema
>;
export type OsCollaborationSourceKind = z.infer<
	typeof OsCollaborationSourceKindSchema
>;
export type OsCollaborationProposal = z.infer<
	typeof OsCollaborationProposalSchema
>;
export type OsWorkspaceStatus = z.infer<typeof OsWorkspaceStatusSchema>;
export type OsWorkspacePreference = z.infer<typeof OsWorkspacePreferenceSchema>;
export type OsGadgetStatus = z.infer<typeof OsGadgetStatusSchema>;
export type OsBlueprintStatus = z.infer<typeof OsBlueprintStatusSchema>;
export type OsWorkspace = z.infer<typeof OsWorkspaceSchema>;
export type OsGadget = z.infer<typeof OsGadgetSchema>;
export type OsGadgetManifest = z.infer<typeof OsGadgetManifestSchema>;
export type OsGadgetExportDescriptor = z.infer<
	typeof OsGadgetExportDescriptorSchema
>;
export type OsGadgetRevision = z.infer<typeof OsGadgetRevisionSchema>;
export type OsBlueprint = z.infer<typeof OsBlueprintSchema>;
export type OsBlueprintDefinition = z.infer<typeof OsBlueprintDefinitionSchema>;
export type OsBlueprintRevision = z.infer<typeof OsBlueprintRevisionSchema>;
