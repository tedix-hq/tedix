import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import type { WorkItemExecutionPreflight } from "@tedix/api-contract/schemas/work-items";
import { WorkItemCapabilityBundleSchema } from "@tedix/api-contract/schemas/work-items";
import { resolveExecutionRequirement } from "@tedix/api-contract/utils/execution-requirement";
import type { DbClient } from "@tedix/db/client";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import {
	getPolicyPackById,
	getRuntimeProfileById,
	getSystemDefaultPolicyPack,
	getSystemDefaultRuntimeProfile,
} from "@tedix/db/queries/control-plane/definitions";
import { getTediById } from "@tedix/db/queries/tedis";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import type { WorkItem } from "@tedix/db/schema/work-items";
import {
	deriveRequiresApproval,
	getTediCapabilityCards,
} from "../rpc/routers/kernel/tedi-capabilities";
import { resolveConnectionAvailability } from "./connection-availability";

type Decision = WorkItemExecutionPreflight["decisions"][number];

/**
 * The exact Work Item fields the preflight reads. Governed gadget dispatch
 * reuses the machinery with a synthetic subject (its capability bundle derived
 * from the gadget manifest), so the input is this narrow Pick rather than a
 * full row.
 */
export type ExecutionPreflightSubject = Pick<
	WorkItem,
	"id" | "orgId" | "metadata" | "accountableOwnerId" | "accountableOwnerType"
>;

function blockedResult(input: {
	workItemId: string;
	manifest: WorkItemExecutionPreflight["manifest"];
	decisions: Decision[];
	resolvedAt: string;
	blockingReasons: string[];
	status?: "not_configured" | "blocked";
}): WorkItemExecutionPreflight {
	return {
		workItemId: input.workItemId,
		status: input.status ?? (input.manifest ? "blocked" : "not_configured"),
		dispatchAllowed: false,
		manifest: input.manifest,
		targetTedi: null,
		runtimeProfile: null,
		policyPack: null,
		executionRequirement: input.manifest
			? resolveExecutionRequirement(input.manifest)
			: null,
		decisions: input.decisions,
		blockingReasons: input.blockingReasons,
		resolvedAt: input.resolvedAt,
	};
}

/**
 * Why a connection did not resolve. The verdict a caller derives from this
 * differs by path, so the cause is reported rather than pre-collapsed:
 *
 * - `no_token` is the only cause a human can fix by consenting (Descope
 *   Adaptive Connect, which requires a user JWT — a tedi or M2M principal
 *   structurally cannot mint the connect URL). Blueprint preflight maps it to
 *   `consent_required`.
 * - Every other cause is a platform/config gap no consent flow repairs, so it
 *   stays `missing`.
 *
 * Work Item dispatch preflight deliberately collapses all of them to `missing`:
 * unlike blueprint instantiation, dispatch cannot proceed either way.
 */
/** Read-only, org-scoped pre-dispatch resolution. It never mints authority. */
export async function resolveWorkItemExecutionPreflight(input: {
	db: DbClient;
	env: CloudflareEnv;
	workItem: ExecutionPreflightSubject;
	now?: string;
}): Promise<WorkItemExecutionPreflight> {
	const resolvedAt = input.now ?? new Date().toISOString();
	const parsed = WorkItemCapabilityBundleSchema.safeParse(
		input.workItem.metadata?.capabilityBundle,
	);
	if (!parsed.success) {
		const configured = input.workItem.metadata?.capabilityBundle !== undefined;
		const reason = configured
			? "capability bundle metadata is invalid"
			: "this Work Item has no capability bundle";
		return blockedResult({
			workItemId: input.workItem.id,
			manifest: null,
			decisions: [
				{
					kind: "assignment",
					subject: "capability_bundle",
					verdict: configured ? "denied" : "not_required",
					reason,
				},
			],
			resolvedAt,
			blockingReasons: configured ? [reason] : [],
			status: configured ? "blocked" : "not_configured",
		});
	}
	const manifest = parsed.data;
	const executionRequirement = resolveExecutionRequirement(manifest);
	const targetTediId =
		manifest.targetTediId ??
		(input.workItem.accountableOwnerType === "tedi"
			? input.workItem.accountableOwnerId
			: null);
	if (!targetTediId) {
		const reason = "capability preflight requires a target or assigned tedi";
		return blockedResult({
			workItemId: input.workItem.id,
			manifest,
			decisions: [
				{
					kind: "assignment",
					subject: "target_tedi",
					verdict: "missing",
					reason,
				},
			],
			resolvedAt,
			blockingReasons: [reason],
		});
	}

	const tedi = await getTediById(input.db, targetTediId);
	if (!tedi || tedi.organizationId !== input.workItem.orgId) {
		const reason = "the selected tedi does not exist in this organization";
		return blockedResult({
			workItemId: input.workItem.id,
			manifest,
			decisions: [
				{
					kind: "assignment",
					subject: targetTediId,
					verdict: "denied",
					reason,
				},
			],
			resolvedAt,
			blockingReasons: [reason],
		});
	}

	// Fall back to the system defaults exactly as `apps/tedi/src/resolve.ts`
	// does. These FKs are nullable and documented as "falls back to system
	// defaults when null" (packages/db/src/schema/tedis.ts), and the RUNTIME
	// already honours that — a tedi with null FKs executes under the
	// system-default profile and policy pack when dispatched through the tedi
	// edge. Preflight was the only resolver that did not, so it blocked work the
	// runtime would happily have run, reporting "no resolvable runtime profile"
	// for a tedi that resolves one everywhere else.
	//
	// This grants nothing new: the same defaults, from the same rows, that the
	// execution path already applies. It is a consistency fix, not a loosening —
	// and the gap was platform-wide, not cosmetic: ALL 27 tedis across ALL 19
	// organizations carry null FKs today, so every governed dispatch through
	// this preflight was denied.
	const [runtimeProfile, policyPack, capabilityCards] = await Promise.all([
		tedi.runtimeProfileId
			? getRuntimeProfileById(input.db, tedi.runtimeProfileId)
			: getSystemDefaultRuntimeProfile(input.db),
		tedi.policyPackId
			? getPolicyPackById(input.db, tedi.policyPackId)
			: getSystemDefaultPolicyPack(input.db),
		getTediCapabilityCards(input.db, input.workItem.orgId),
	]);
	const card = capabilityCards.find(
		(candidate) => candidate.tediId === tedi.id,
	);
	const requiresApproval = deriveRequiresApproval(
		policyPack?.definition,
		tedi.governanceOverride,
	);
	const tediDispatchable = card !== undefined;
	const assignmentReason = tediDispatchable
		? manifest.targetTediId
			? "the capability bundle explicitly selects this tedi"
			: "the Work Item assignment selects this tedi"
		: `the selected tedi is not dispatchable in its current ${tedi.status}/${tedi.runtimeState} state`;
	const decisions: Decision[] = [
		{
			kind: "assignment",
			subject: tedi.slug,
			verdict: tediDispatchable ? "allowed" : "denied",
			reason: assignmentReason,
		},
	];
	const blockingReasons: string[] = tediDispatchable ? [] : [assignmentReason];

	if (runtimeProfile?.status !== "active") {
		// A null FK no longer reaches here — it resolves to the system default
		// above. So "missing" now means the seeded system-default row itself is
		// absent, which is a platform fault affecting every org, not a
		// misconfiguration of this one tedi. Say which.
		const reason = runtimeProfile
			? `runtime profile ${runtimeProfile.slug} is ${runtimeProfile.status}`
			: tedi.runtimeProfileId
				? `runtime profile ${tedi.runtimeProfileId} is pinned on this tedi but no longer exists`
				: "no active published system-default runtime profile exists in this deployment";
		decisions.push({
			kind: "runtime_profile",
			subject: runtimeProfile?.slug ?? "runtime_profile",
			verdict: runtimeProfile ? "denied" : "missing",
			reason,
		});
		blockingReasons.push(reason);
	} else {
		decisions.push({
			kind: "runtime_profile",
			subject: runtimeProfile.slug,
			verdict: "allowed",
			reason: `active ${runtimeProfile.scope} runtime profile`,
		});
	}

	if (policyPack?.status !== "active") {
		const reason = policyPack
			? `policy pack ${policyPack.slug} is ${policyPack.status}`
			: tedi.policyPackId
				? `policy pack ${tedi.policyPackId} is pinned on this tedi but no longer exists`
				: "no active published system-default policy pack exists in this deployment";
		decisions.push({
			kind: "policy",
			subject: policyPack?.slug ?? "policy_pack",
			verdict: policyPack ? "denied" : "missing",
			reason,
		});
		blockingReasons.push(reason);
	} else {
		decisions.push({
			kind: "policy",
			subject: policyPack.slug,
			verdict: requiresApproval ? "approval_required" : "allowed",
			reason: requiresApproval
				? "the active policy requires human approval before autonomous dispatch"
				: "the active policy permits autonomous dispatch; call-time gates still apply",
		});
	}

	if (!executionRequirement.satisfiable) {
		blockingReasons.push(executionRequirement.reason);
	}
	const needsWorkstation = executionRequirement.surface !== "native";
	if (needsWorkstation) {
		const workstationAllowed = card?.embodied === true;
		const reason = workstationAllowed
			? card?.hasWarmWorkstationLease
				? "a configured workstation is eligible and currently warm"
				: "a configured workstation is eligible and may be provisioned on demand"
			: "the selected tedi has neither a configured repository nor a warm workstation lease";
		decisions.push({
			kind: "workstation",
			subject: executionRequirement.surface,
			verdict: workstationAllowed ? "allowed" : "denied",
			reason,
		});
		if (!workstationAllowed) blockingReasons.push(reason);
	} else {
		decisions.push({
			kind: "workstation",
			subject: "workstation",
			verdict: "not_required",
			reason: "the capability bundle resolves to the native execution surface",
		});
	}
	if (manifest.requiredCapabilities.includes("browser_session")) {
		const browserAllowed = card?.embodied === true;
		const reason = browserAllowed
			? "the general workstation profile can provide a governed browser session"
			: "browser sessions require workstation eligibility";
		decisions.push({
			kind: "browser",
			subject: "browser_session",
			verdict: browserAllowed ? "allowed" : "denied",
			reason,
		});
		if (!browserAllowed) blockingReasons.push(reason);
	}

	for (const requirement of manifest.tools) {
		const subject = `${requirement.appSlug}:${requirement.toolId}`;
		const app = await getAppBySlugForOrg(
			input.db,
			requirement.appSlug,
			input.workItem.orgId,
		);
		if (!app || !card?.apps.includes(requirement.appSlug)) {
			const reason = app
				? `app ${requirement.appSlug} is not in the tedi's config-driven assignment projection`
				: `app ${requirement.appSlug} does not exist in this organization`;
			decisions.push({
				kind: "app_assignment",
				subject: requirement.appSlug,
				verdict: app ? "denied" : "missing",
				reason,
			});
			blockingReasons.push(reason);
			continue;
		}
		decisions.push({
			kind: "app_assignment",
			subject: requirement.appSlug,
			verdict: "allowed",
			reason:
				"the app is present in the tedi's config-driven assignment projection",
		});
		const tool = await getToolByAppAndToolIdForOrganization(input.db, {
			organizationId: input.workItem.orgId,
			appId: app.id,
			toolId: requirement.toolId,
		});
		if (tool?.enabled !== true) {
			const reason = tool
				? `tool ${subject} is disabled`
				: `tool ${subject} is missing`;
			decisions.push({
				kind: "tool",
				subject,
				verdict: tool ? "denied" : "missing",
				reason,
			});
			blockingReasons.push(reason);
			continue;
		}
		const policy = parseToolPolicyMetadata(tool.meta);
		const destructive = tool.annotations?.destructiveHint === true;
		const readOnly = tool.annotations?.readOnlyHint === true;
		const approvalRequired = destructive || (!readOnly && requiresApproval);
		decisions.push({
			kind: "tool",
			subject,
			verdict: approvalRequired ? "approval_required" : "allowed",
			reason: destructive
				? "destructive tool calls require call-time approval"
				: approvalRequired
					? "the tedi policy requires approval for this non-read-only tool"
					: policy?.risk
						? `enabled tool; declared policy risk is ${policy.risk}`
						: "enabled tool is available; call-time MCP policy remains authoritative",
		});
	}

	for (const requirement of manifest.connections) {
		const connection = await resolveConnectionAvailability({
			db: input.db,
			env: input.env,
			organizationId: input.workItem.orgId,
			ownerUserId: tedi.ownerUserId,
			providerId: requirement.providerId,
			tokenScope: requirement.tokenScope,
			scopes: requirement.scopes,
		});
		decisions.push({
			kind: "connection",
			subject: requirement.providerId,
			verdict: connection.connected ? "allowed" : "missing",
			reason: connection.reason,
		});
		if (!connection.connected) blockingReasons.push(connection.reason);
	}

	const uniqueBlockingReasons = [...new Set(blockingReasons)];
	const hasApproval = decisions.some(
		(decision) => decision.verdict === "approval_required",
	);
	const status =
		uniqueBlockingReasons.length > 0
			? "blocked"
			: hasApproval
				? "needs_approval"
				: "ready";
	return {
		workItemId: input.workItem.id,
		status,
		dispatchAllowed: status === "ready",
		manifest,
		targetTedi: {
			id: tedi.id,
			slug: tedi.slug,
			name: tedi.displayName || tedi.name || tedi.slug,
		},
		runtimeProfile: runtimeProfile
			? {
					id: runtimeProfile.id,
					slug: runtimeProfile.slug,
					name: runtimeProfile.name,
					status: runtimeProfile.status,
				}
			: null,
		policyPack: policyPack
			? {
					id: policyPack.id,
					slug: policyPack.slug,
					name: policyPack.name,
					status: policyPack.status,
					requiresApproval,
				}
			: null,
		executionRequirement,
		decisions,
		blockingReasons: uniqueBlockingReasons,
		resolvedAt,
	};
}
