/**
 * Audit emission for the Tedix OS domains.
 *
 * Workspace, gadget, output, blueprint, collaboration, share and approval-rule
 * lifecycle are governance events: "who archived this workspace", "who minted
 * that share link", "who turned auto-approval on" must be answerable from
 * `audit_events`, not only from the execution-receipt table (which projects
 * runs, never authoring or policy changes).
 *
 * WHY A MIDDLEWARE, NOT ~30 CALL SITES
 * ------------------------------------
 * The gap this closes happened because emission was per-handler and therefore
 * optional: five OS routers shipped with zero `emitAuditEvent` calls and
 * nothing failed. Emission lives here instead, applied once per router builder,
 * so a verb added later is covered by construction — and if it is NOT in the
 * registry below, `os-audit.coverage.test.ts` fails, which is what makes
 * "silently ships without audit" impossible rather than merely discouraged.
 *
 * READS CANNOT BE WIRED (structural, not conventional)
 * ----------------------------------------------------
 * Two independent gates, neither of which relies on anyone remembering:
 *  1. Runtime — `isMutatingProcedure` reads the procedure's own declared
 *     OpenAPI method and only POST/PUT/PATCH/DELETE reaches the write path.
 *     A GET procedure wired into a registry by mistake emits nothing.
 *  2. Build — the coverage test asserts every registry key resolves to a
 *     contract leaf whose declared method is a mutating one, so wiring a read
 *     is a red test rather than a polluted audit table.
 *
 * FAILURE POLICY: FAIL-SOFT, NEVER SILENT
 * ---------------------------------------
 * The audit insert is a separate D1 statement — it is never part of the
 * mutation's own `db.batch()`, so it cannot roll the mutation back. By the time
 * it runs the write has already committed. Throwing here would therefore report
 * failure for work that actually happened, which is strictly worse than a
 * recorded gap: the caller retries and double-writes. So emission is awaited
 * (never `waitUntil` — the row must be readable by an immediately following
 * `audit.get_audit_by_resource`) and every failure is caught and logged at
 * error level with the action and resource that were lost. This follows the
 * repo's most recent, explicitly reasoned precedent — `tedis/crud.ts` and
 * `tedis/runtime.ts` both state "never let audit I/O mask the real outcome".
 */

import { os as orpc } from "@orpc/server";
import type { BaseContext } from "./context";

/** Loose object view of an unknown value; non-objects read as empty. */
type Fields = Record<string, unknown>;

/** The validated input and the raw handler output of one procedure call. */
export interface OsAuditFrame {
	readonly input: Fields;
	readonly output: Fields;
}

export interface OsAuditSpec {
	/** `os.{noun}.{verb_past}` — the repo's dominant audit action dialect. */
	readonly action: string;
	/** Exact string `audit.get_audit_by_resource` matches on. */
	readonly resourceType: string;
	/**
	 * The id a caller would naturally look the event up by.
	 *
	 * Returning a `string` means "one row"; `undefined` is an extraction bug and
	 * is logged, with the row still written (so `audit.search` by action keeps
	 * the event) rather than dropped. Returning an ARRAY means "exactly these
	 * rows" and an empty array is a legitimate no-op, not a failure.
	 */
	readonly resourceId: (
		frame: OsAuditFrame,
	) => string | readonly string[] | undefined;
	/** Extra context. Declared per verb — never the raw output (secrets). */
	readonly metadata?: (frame: OsAuditFrame) => Fields;
}

/**
 * Contract paths (dotted, without the namespace segment) to what they emit.
 *
 * Keyed by the longest matching suffix of the procedure path, because oRPC
 * reports `["osWorkspaces","gadgets","create"]` over HTTP but
 * `["gadgets","create"]` through `createRouterClient` — which is how every OS
 * test calls in. Keying on the full path would make the audit dead in tests
 * while looking wired.
 */
export type OsAuditRegistry = Readonly<
	Record<string, OsAuditSpec | readonly OsAuditSpec[]>
>;

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function fields(value: unknown): Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Fields)
		: {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `source[key].id` — the shape every OS mutation returns. */
function nestedId(source: Fields, key: string): string | undefined {
	return text(fields(source[key]).id);
}

/** Revision number, recorded so a diff can be reconstructed from the trail. */
function revisionNumber(source: Fields, key = "revision"): number | undefined {
	const value = fields(source[key]).revision;
	return typeof value === "number" ? value : undefined;
}

/**
 * Stamped by `apps/os/src/lib/webmcp/attribution.ts` on requests issued while
 * a native WebMCP tool execute is in flight (constant duplicated there — apps
 * cannot import each other and the string is the wire contract). Telemetry
 * metadata only: it grants nothing, so worker-kit's inbound trust-header
 * hygiene deliberately forwards it. Never let it influence authorization.
 */
const WEBMCP_INVOCATION_HEADER = "X-Tedix-Webmcp-Invocation";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `{ webmcpInvocationId, agentInitiated: true }` when the request carries a
 * well-formed WebMCP invocation id; `{}` otherwise. The value is
 * client-claimed, so anything but an exact UUID is ignored rather than stored
 * — a malformed value must not become operator-readable audit content.
 */
function webMcpAttribution(headers: Headers): Fields {
	const value = headers.get(WEBMCP_INVOCATION_HEADER);
	if (value === null || !UUID_PATTERN.test(value)) return {};
	return { webmcpInvocationId: value.toLowerCase(), agentInitiated: true };
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/**
 * Gadget runs and their settlement are keyed on the GADGET id under
 * `os_gadget_execution`, not on the execution id: the reader has no prefix,
 * action or time filter, so keying on the gadget makes one call return that
 * gadget's whole execution-governance history. The execution id travels in
 * metadata.
 */
const EXECUTION_RESOURCE = "os_gadget_execution";

/**
 * The mutable fields `workspaceUpdateSchema` actually permits
 * (`packages/api-contract/src/contracts/os-workspaces.ts`). Recording WHICH of
 * these changed is the useful audit signal; recording the caller's raw key
 * names is an injection surface, so the extractor intersects against this list
 * rather than reading the input's own keys.
 */
const WORKSPACE_UPDATE_FIELDS = ["name", "description"] as const;

/** Shared by `os-workspaces.ts` and `os-workspace-library.ts`. */
export const OS_WORKSPACES_AUDIT: OsAuditRegistry = {
	"workspaces.create": {
		action: "os.workspace.created",
		resourceType: "os_workspace",
		resourceId: ({ output }) => nestedId(output, "workspace"),
		metadata: ({ output }) => ({ name: fields(output.workspace).name }),
	},
	"workspaces.update": {
		action: "os.workspace.updated",
		resourceType: "os_workspace",
		resourceId: ({ output }) => nestedId(output, "workspace"),
		// Intersected with the contract's OWN field set, never the raw input's
		// keys. This middleware sits ABOVE `.input()`, so `Object.keys(input)`
		// is pre-validation: keys zod would strip still reached the row. A
		// caller could name a field `ssn 123-45-6789 jane@acme.example` — or
		// 20 KB of padding — and have it persist verbatim in an
		// operator-readable audit row for the full 90-day retention window.
		// Values never leaked, but caller-chosen KEY NAMES did.
		metadata: ({ input }) => ({
			changed: WORKSPACE_UPDATE_FIELDS.filter((field) =>
				Object.hasOwn(fields(input), field),
			),
		}),
	},
	"workspaces.archive": {
		action: "os.workspace.archived",
		resourceType: "os_workspace",
		resourceId: ({ output }) => nestedId(output, "workspace"),
	},
	"workspaces.delete": {
		action: "os.workspace.deleted",
		resourceType: "os_workspace",
		resourceId: ({ input }) => text(input.workspaceId),
	},
	"workspaces.decideBlueprintUpgrade": {
		action: "os.workspace.blueprint_upgrade_decided",
		resourceType: "os_workspace",
		resourceId: ({ output }) => nestedId(output, "workspace"),
		metadata: ({ input, output }) => ({
			decision: input.decision,
			candidateRevisionId: input.candidateRevisionId,
			reason: input.reason ?? null,
			pinnedRevisionId: fields(output.decision).pinnedRevisionId ?? null,
		}),
	},
	"resources.create": {
		action: "os.workspace_resource.created",
		resourceType: "os_workspace_resource",
		resourceId: ({ output }) => nestedId(output, "resource"),
		metadata: ({ input, output }) => ({
			workspaceId: input.workspaceId,
			providerId: fields(output.resource).providerId,
			resourceType: fields(output.resource).resourceType,
			connectionScope: fields(output.resource).connectionScope,
		}),
	},
	"resources.startRepositoryWork": {
		action: "os.workspace_repository_work.prepared",
		resourceType: "work_item",
		resourceId: ({ output }) => text(output.workItemId),
		metadata: ({ input }) => ({
			workspaceId: input.workspaceId,
			workspaceResourceId: input.resourceId,
			projectId: input.projectId,
			tediId: input.tediId,
		}),
	},
	"resources.rename": {
		action: "os.workspace_resource.renamed",
		resourceType: "os_workspace_resource",
		resourceId: ({ output }) => nestedId(output, "resource"),
		metadata: ({ input }) => ({ workspaceId: input.workspaceId }),
	},
	"resources.rebind": {
		action: "os.workspace_resource.rebound",
		resourceType: "os_workspace_resource",
		resourceId: ({ output }) => nestedId(output, "resource"),
		metadata: ({ input, output }) => ({
			workspaceId: input.workspaceId,
			providerId: fields(output.resource).providerId,
			connectionScope: fields(output.resource).connectionScope,
		}),
	},
	"resources.remove": {
		action: "os.workspace_resource.removed",
		resourceType: "os_workspace_resource",
		resourceId: ({ output }) => nestedId(output, "resource"),
		metadata: ({ input }) => ({ workspaceId: input.workspaceId }),
	},
	"work.attachProject": {
		action: "os.workspace_project.attached",
		resourceType: "os_workspace_project",
		resourceId: ({ output }) => nestedId(output, "link"),
		metadata: ({ input }) => ({
			workspaceId: input.workspaceId,
			projectId: input.projectId,
		}),
	},
	"work.removeProject": {
		action: "os.workspace_project.removed",
		resourceType: "os_workspace_project",
		resourceId: ({ output }) => nestedId(output, "link"),
		metadata: ({ input }) => ({
			workspaceId: input.workspaceId,
			projectId: input.projectId,
		}),
	},
	"gadgets.create": {
		action: "os.gadget.created",
		resourceType: "os_gadget",
		resourceId: ({ output }) => nestedId(output, "gadget"),
		metadata: ({ input, output }) => ({
			workspaceId: input.workspaceId,
			name: fields(output.gadget).name,
		}),
	},
	"gadgets.revise": {
		action: "os.gadget.revised",
		resourceType: "os_gadget",
		resourceId: ({ output }) => nestedId(output, "gadget"),
		metadata: ({ output }) => ({
			revision: revisionNumber(output),
			revisionId: nestedId(output, "revision"),
		}),
	},
	"gadgets.archive": {
		action: "os.gadget.archived",
		resourceType: "os_gadget",
		resourceId: ({ output }) => nestedId(output, "gadget"),
	},
	"gadgets.delete": {
		action: "os.gadget.deleted",
		resourceType: "os_gadget",
		// `{ deleted: true }` carries no id: the deleted resource is the input's.
		resourceId: ({ input }) => text(input.gadgetId),
		metadata: ({ input }) => ({ workspaceId: input.workspaceId }),
	},
	"gadgets.run": {
		action: "os.gadget_execution.requested",
		resourceType: EXECUTION_RESOURCE,
		resourceId: ({ input, output }) =>
			text(input.gadgetId) ?? text(fields(output.execution).gadgetId),
		metadata: ({ input, output }) => ({
			workspaceId: input.workspaceId,
			executionId: nestedId(output, "execution"),
			status: fields(output.execution).status,
			policyDecision: fields(output.execution).policyDecision ?? null,
		}),
	},
	"executions.export": {
		action: "os.gadget_execution.exported",
		resourceType: EXECUTION_RESOURCE,
		resourceId: ({ input }) => text(input.gadgetId),
		metadata: ({ input, output }) => ({
			workspaceId: input.workspaceId,
			executionId: input.executionId,
			exportId: input.exportId,
			fileName: output.fileName,
			sizeBytes: output.sizeBytes,
		}),
	},
	"outputs.create": {
		action: "os.output.created",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ output }) => ({
			workspaceId: fields(output.output).workspaceId,
			kind: fields(output.output).kind,
			title: fields(output.output).title,
		}),
	},
	"outputs.rename": {
		action: "os.output.renamed",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ output }) => ({ title: fields(output.output).title }),
	},
	"outputs.revise": {
		action: "os.output.revised",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ output }) => ({ revision: revisionNumber(output) }),
	},
	"outputs.patchDocument": {
		action: "os.output.document_patched",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ input, output }) => ({
			revision: revisionNumber(output),
			operations: Array.isArray(input.ops) ? input.ops.length : 0,
		}),
	},
	"outputs.patchSlides": {
		action: "os.output.slides_patched",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ input, output }) => ({
			revision: revisionNumber(output),
			operations: Array.isArray(input.ops) ? input.ops.length : 0,
		}),
	},

	"outputs.setSheetRange": {
		action: "os.output.sheet_range_written",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
		metadata: ({ output }) => ({ revision: revisionNumber(output) }),
	},
	"outputs.archive": {
		action: "os.output.archived",
		resourceType: "os_output",
		resourceId: ({ output }) => nestedId(output, "output"),
	},
	"outputs.delete": {
		action: "os.output.deleted",
		resourceType: "os_output",
		resourceId: ({ input }) => text(input.outputId),
	},
	"collaboration.create": {
		action: "os.collaboration_proposal.created",
		resourceType: "os_collaboration_proposal",
		resourceId: ({ output }) => nestedId(output, "proposal"),
		metadata: ({ output }) => ({
			workspaceId: fields(output.proposal).workspaceId,
			documentType: fields(output.proposal).documentType,
			documentId: fields(output.proposal).documentId,
		}),
	},
	"collaboration.accept": {
		action: "os.collaboration_proposal.accepted",
		resourceType: "os_collaboration_proposal",
		resourceId: ({ output }) => nestedId(output, "proposal"),
		metadata: ({ input }) => ({ rationale: input.rationale ?? null }),
	},
	"collaboration.reject": {
		action: "os.collaboration_proposal.rejected",
		resourceType: "os_collaboration_proposal",
		resourceId: ({ output }) => nestedId(output, "proposal"),
		metadata: ({ input }) => ({ rationale: input.rationale ?? null }),
	},
	"collaboration.merge": {
		action: "os.collaboration_proposal.merged",
		resourceType: "os_collaboration_proposal",
		resourceId: ({ output }) => nestedId(output, "proposal"),
		metadata: ({ output }) => ({
			revisionId: nestedId(output, "revision"),
			revision: revisionNumber(output),
			documentId: fields(output.proposal).documentId,
		}),
	},
	"blueprints.create": {
		action: "os.blueprint.created",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
		metadata: ({ output }) => ({ name: fields(output.blueprint).name }),
	},
	"blueprints.revise": {
		action: "os.blueprint.revised",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
		metadata: ({ output }) => ({
			revision: revisionNumber(output),
			revisionId: nestedId(output, "revision"),
		}),
	},
	"blueprints.publish": {
		action: "os.blueprint.published",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
		metadata: ({ output }) => ({ revision: revisionNumber(output) }),
	},
	"blueprints.archive": {
		action: "os.blueprint.archived",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
	},
	"blueprints.delete": {
		action: "os.blueprint.deleted",
		resourceType: "os_blueprint",
		resourceId: ({ input }) => text(input.blueprintId),
	},
	"blueprints.setVisibility": {
		action: "os.blueprint.visibility_set",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
		metadata: ({ input }) => ({ visibility: input.visibility }),
	},
	"blueprints.import": {
		action: "os.blueprint.imported",
		resourceType: "os_blueprint",
		resourceId: ({ output }) => nestedId(output, "blueprint"),
		metadata: ({ output }) => ({ name: fields(output.blueprint).name }),
	},
	// Two rows: the materialized workspace answers "where did this come from",
	// the source blueprint answers "who instantiated it". Both lookups matter
	// and the reader cannot bridge them from one row.
	"blueprints.instantiate": [
		{
			action: "os.blueprint.instantiated",
			resourceType: "os_workspace",
			resourceId: ({ output }) => nestedId(output, "workspace"),
			metadata: ({ output }) => ({
				blueprintId: nestedId(output, "blueprint"),
				revision: revisionNumber(output),
				gadgets: Array.isArray(output.gadgets) ? output.gadgets.length : 0,
			}),
		},
		{
			action: "os.blueprint.instantiated",
			resourceType: "os_blueprint",
			resourceId: ({ output }) => nestedId(output, "blueprint"),
			metadata: ({ output }) => ({
				workspaceId: nestedId(output, "workspace"),
				revision: revisionNumber(output),
			}),
		},
	],
	"blueprints.instantiateFromGallery": [
		{
			action: "os.blueprint.instantiated_from_gallery",
			resourceType: "os_workspace",
			resourceId: ({ output }) => nestedId(output, "workspace"),
			metadata: ({ input, output }) => ({
				sourceBlueprintId: input.blueprintId,
				copiedBlueprintId: nestedId(output, "blueprint"),
				gadgets: Array.isArray(output.gadgets) ? output.gadgets.length : 0,
			}),
		},
		{
			action: "os.blueprint.instantiated_from_gallery",
			resourceType: "os_blueprint",
			resourceId: ({ output }) => nestedId(output, "blueprint"),
			metadata: ({ input, output }) => ({
				sourceBlueprintId: input.blueprintId,
				workspaceId: nestedId(output, "workspace"),
			}),
		},
	],
};

export const OS_SHARES_AUDIT: OsAuditRegistry = {
	// `output.token` is the one-time plaintext share credential and is
	// deliberately NOT in metadata — an audit table is readable by every
	// analytics:read principal.
	"shares.create": {
		action: "os.share_link.created",
		resourceType: "os_share_link",
		resourceId: ({ output }) => nestedId(output, "share"),
		metadata: ({ output }) => ({
			sharedResourceType: fields(output.share).resourceType,
			sharedResourceId: fields(output.share).resourceId,
			role: fields(output.share).role,
			revisionMode: fields(output.share).revisionMode,
			expiresAt: fields(output.share).expiresAt ?? null,
		}),
	},
	"shares.revoke": {
		action: "os.share_link.revoked",
		resourceType: "os_share_link",
		resourceId: ({ output }) => nestedId(output, "share"),
		metadata: ({ output }) => ({
			sharedResourceType: fields(output.share).resourceType,
			sharedResourceId: fields(output.share).resourceId,
			revokedSessionCount: output.revokedSessionCount ?? null,
		}),
	},
	"shares.restrict": {
		action: "os.share_link.restricted",
		resourceType: "os_share_link",
		resourceId: ({ output }) => nestedId(output, "share"),
		metadata: ({ output }) => ({
			sharedResourceType: fields(output.share).resourceType,
			sharedResourceId: fields(output.share).resourceId,
			policyMaxRole: fields(output.share).policyMaxRole ?? null,
			policyReason: fields(output.share).policyReason ?? null,
			revokedSessionCount: output.revokedSessionCount ?? null,
		}),
	},
	"shares.delete": {
		action: "os.share_link.deleted",
		resourceType: "os_share_link",
		resourceId: ({ input }) => text(input.shareId),
	},
};

/** `[{approvalId, ruleId}]` from an approval-rule sweep result. */
function sweepMatches(frame: OsAuditFrame): Fields[] {
	const value = frame.output.ruleMatches;
	return Array.isArray(value) ? value.map(fields) : [];
}

export const OS_APPROVAL_RULES_AUDIT: OsAuditRegistry = {
	create: {
		action: "os.approval_rule.created",
		resourceType: "os_approval_rule",
		resourceId: ({ output }) => nestedId(output, "rule"),
		metadata: ({ output }) => ({
			actionKind: fields(output.rule).actionKind,
			decision: fields(output.rule).decision,
			enabled: fields(output.rule).enabled,
		}),
	},
	setEnabled: {
		action: "os.approval_rule.enabled_set",
		resourceType: "os_approval_rule",
		resourceId: ({ output }) => nestedId(output, "rule"),
		metadata: ({ input, output }) => ({
			enabled: input.enabled,
			actionKind: fields(output.rule).actionKind,
		}),
	},
	delete: {
		action: "os.approval_rule.deleted",
		resourceType: "os_approval_rule",
		resourceId: ({ input }) => text(input.ruleId),
	},
	// One row per rule that actually auto-resolved something, so the sweep is
	// findable from the rule it was governed by. A sweep that matched nothing
	// changed nothing and writes nothing (the array form permits zero rows).
	apply: {
		action: "os.approval_rule.applied",
		resourceType: "os_approval_rule",
		resourceId: (frame) => [
			...new Set(
				sweepMatches(frame).flatMap((match) => {
					const ruleId = text(match.ruleId);
					return ruleId ? [ruleId] : [];
				}),
			),
		],
		metadata: (frame) => ({
			resolved: frame.output.resolved,
			matches: sweepMatches(frame),
		}),
	},
};

/**
 * Mutating OS procedures that deliberately write no audit row, each with the
 * reason. This is the other half of the coverage gate: a verb is either
 * registered above or named here, so `os-audit.coverage.test.ts` turns red on
 * anything new and nothing can ship un-decided. Keyed exactly like the
 * registries (dotted contract path without the namespace segment).
 */
/**
 * Keys are DOMAIN-QUALIFIED (`<contractName>.<leafPath>`). A bare leaf path
 * would excuse that path in EVERY OS contract at once, so a future
 * `osShares.resolve` would inherit `osTenant.resolve`'s excuse silently — the
 * precise class of silent exemption this allowlist exists to prevent.
 * @internal
 */
export const OS_AUDIT_NON_EMITTING: Readonly<Record<string, string>> = {
	// Presentation-only, per-user, and not org state: favorites and recency live
	// in user_configs and govern nothing.
	"osWorkspaces.workspacePreferences.setFavorite":
		"personal presentation preference",
	"osWorkspaces.workspacePreferences.touch": "personal recency ping",
	// Draft churn: a live collaborative session updates the preview many times a
	// minute. The governance events are create / accept / reject / merge, which
	// all emit.
	"osWorkspaces.collaboration.updatePreview":
		"non-canonical draft preview churn",
	// POST-shaped read: renders the current revision and stores bytes in R2;
	// nothing in the domain changes.
	"osWorkspaces.outputs.export": "render-only, mutates no OS state",
	// POST-shaped read on the edge routing path: the OS Worker asks whether a
	// hostname is a provisioned tenant. It mutates nothing, runs before any
	// caller identity exists, and has no org to scope a row to — auditing it
	// would write a row per cold request with no actor.
	"osTenant.resolve": "hostname routing lookup, no org scope, no mutation",
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Methods that may write an audit row. Anything else (GET, unknown) may not. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The declared OpenAPI method of a contract or implemented procedure. */
export function procedureMethod(procedure: unknown): string | undefined {
	const definition = fields(fields(procedure)["~orpc"]);
	return text(fields(fields(definition.meta)["~openapi"]).method);
}

function isMutatingProcedure(procedure: unknown): boolean {
	const method = procedureMethod(procedure);
	return method !== undefined && MUTATING_METHODS.has(method);
}

/** Longest-suffix match, so namespaced and bare procedure paths both resolve. */
export function lookupOsAuditSpecs(
	registry: OsAuditRegistry,
	path: readonly string[],
): readonly OsAuditSpec[] {
	for (let index = 0; index < path.length; index += 1) {
		const entry = registry[path.slice(index).join(".")];
		if (entry === undefined) continue;
		return Array.isArray(entry)
			? (entry as readonly OsAuditSpec[])
			: [entry as OsAuditSpec];
	}
	return [];
}

async function recordOsAuditRows(
	context: BaseContext,
	specs: readonly OsAuditSpec[],
	frame: OsAuditFrame,
): Promise<void> {
	try {
		// Lazy, matching the canonical call site in `organizations.ts`: keeps the
		// audit/query graph off any path that merely imports this module.
		const [{ auditActor, emitAuditEvent }, { requireOrgId }] =
			await Promise.all([import("./audit-helpers"), import("./org-scope")]);
		// Same source the handlers use — never caller input.
		const organizationId = requireOrgId(context);
		const actor = auditActor(context);
		const ipAddress = context.headers.get("CF-Connecting-IP");
		const userAgent = context.headers.get("User-Agent");
		const webmcpAttribution = webMcpAttribution(context.headers);
		for (const spec of specs) {
			const resolved = spec.resourceId(frame);
			const resourceIds =
				typeof resolved === "string" || resolved === undefined
					? [resolved]
					: resolved;
			for (const resourceId of resourceIds) {
				if (resourceId === undefined) {
					console.error(
						`[OsAudit] ${spec.action}: no ${spec.resourceType} id resolved; the event is recorded without one and is not retrievable by resource`,
					);
				}
				// Per-ROW, not per-call: `blueprints.instantiate` writes two rows
				// (the new workspace and the source blueprint) and a single outer
				// catch would drop the second because the first failed. Each row
				// is an independent governance fact.
				try {
					await emitAuditEvent(context.db, {
						organizationId,
						actorId: actor.actorId,
						actorType: actor.actorType,
						action: spec.action,
						resourceType: spec.resourceType,
						resourceId,
						metadata: {
							// Spec metadata FIRST so actor metadata cannot be shadowed
							// by it. Accountability — who did this — must never be
							// overwritable by domain data that happens to reuse a key
							// like `email` or `sessionId`. The WebMCP attribution sits
							// between the two: it may not be shadowed by domain data
							// either, but actor identity still outranks everything.
							...(spec.metadata?.(frame) ?? {}),
							...webmcpAttribution,
							...actor.actorMetadata,
						},
						ipAddress,
						userAgent,
					});
				} catch (error) {
					console.error(
						`[OsAudit] Lost governance event ${spec.action} for ${spec.resourceType} ${resourceId ?? "(unresolved)"}:`,
						error,
					);
				}
			}
		}
	} catch (error) {
		// Fail-soft by design (see the module header) — but never silent.
		console.error(
			`[OsAudit] Lost governance event(s) ${specs
				.map((spec) => spec.action)
				.join(", ")}:`,
			error,
		);
	}
}

/**
 * Emit the registry's audit rows for every mutating procedure under a builder.
 *
 * Apply on the router's authenticated/authorized builder alias; a guard that
 * throws propagates through `next()` and nothing is written, and a handler that
 * throws never reaches the emission either.
 */
export function osAudit(registry: OsAuditRegistry) {
	return orpc
		.$context<BaseContext>()
		.middleware(async (options, input: unknown) => {
			const specs = isMutatingProcedure(options.procedure)
				? lookupOsAuditSpecs(registry, options.path)
				: [];
			const result = await options.next({ context: options.context });
			if (specs.length > 0) {
				await recordOsAuditRows(options.context, specs, {
					input: fields(input),
					output: fields((result as { output?: unknown }).output),
				});
			}
			return result;
		});
}
