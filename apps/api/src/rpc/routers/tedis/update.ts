import { canManageBrowserEgress } from "@tedix/api-contract/schemas/tedi";
import { getRuntimeEntitlement } from "@tedix/db/queries/runtime-entitlements";
import { upsertTediInferencePolicy } from "@tedix/db/queries/billing/inference-policies";
import {
	getRuntimeProfileById,
	getSystemDefaultRuntimeProfile,
} from "@tedix/db/queries/control-plane/definitions";
import { rebindTediControlPlaneRevision } from "@tedix/db/queries/control-plane/revisions";
import { upsertTediSecret } from "@tedix/db/queries/tedi-secrets";
import { updateTedi } from "@tedix/db/queries/tedis";
import { invalidateKernelContextCache } from "../../../kernel/context-cache";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { invalidateConfig } from "@tedix/provisioning";
import { isTediCapabilityDowngrade } from "../../../lib/tedi-aih-client-sync";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	getProvisioningConfig,
	requireOrganizationId,
	requireTediAccess,
	toTediDto,
} from "./helpers";
import { materializeManagedAppAssignments } from "./identity-provisioning";

/**
 * Fields that durably change what a tedi is allowed to do. Invariant: only a
 * caller whose `authType` proves a human or an operator-issued API key may
 * write them. Every other caller (`tedi`, `m2m`, `service-binding`, or an
 * unresolved identity) is refused, so the gate fails closed when identity
 * propagation is incomplete. `requireTediAccess` checks only organization
 * membership, so without this gate one tedi could raise another's tier.
 *
 * - `mcpCapabilityProfile`, `toolPolicy`: the MCP scope tier and the
 *   approve-vs-allow policy for bash/browser/github/deploy.
 * - `repoConfig`: a non-empty `repoUrl` makes a tedi `embodied`
 *   (`kernel/tedi-capabilities.ts`), which changes delegation dispatch and
 *   names the repository a coding tedi writes to.
 * - `cronJobs`: durable self-scheduling (defense in depth; no runtime reads
 *   this column yet).
 * - `budgets`, `runtimeProfileId`, `runtimeOverrides`: model and spend tier.
 */
export const AGENT_UNREACHABLE_CAPABILITY_FIELDS = [
	"mcpCapabilityProfile",
	"toolPolicy",
	"repoConfig",
	"cronJobs",
	"budgets",
	"runtimeProfileId",
	// `agents.defaults.model.primary` pins the model directly.
	"runtimeOverrides",
] as const;

/** `authType` values that cannot be an LLM's own in-turn tool selection. */
const CAPABILITY_MUTATION_TRUSTED_AUTH_TYPES = new Set(["user", "apikey"]);

/**
 * Pure predicate: which capability-tier fields (if any) does this update
 * touch, given the caller's resolved `authType`? Returns an empty array only
 * when `authType` affirmatively proves a human or operator-issued API key —
 * every other value (including `undefined`) is treated as untrusted for this
 * mutation class, regardless of that caller's own granted scopes.
 */
export function agentUnreachableCapabilityFieldsTouched(
	authType: string | undefined,
	data: Record<string, unknown>,
): string[] {
	if (authType && CAPABILITY_MUTATION_TRUSTED_AUTH_TYPES.has(authType)) {
		return [];
	}
	return AGENT_UNREACHABLE_CAPABILITY_FIELDS.filter(
		(field) => data[field] !== undefined,
	);
}

export const updateTediProcedure = authedTedisOs.update
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const { tediId, ...data } = input;
		const existingTedi = await requireTediAccess(context, tediId);

		// See AGENT_UNREACHABLE_CAPABILITY_FIELDS above. Checked before any
		// privilege/scope lookup so a tedi's own elevated scopes (platform:admin)
		// cannot bypass this — the gate is on the mutation, not the caller.
		// Allowlist, not denylist: only an affirmatively-verified human or
		// operator-issued API key may pass. This does not trust "not a known
		// tedi" as proof of safety (that signal has a demonstrated propagation
		// gap — see the comment above AGENT_UNREACHABLE_CAPABILITY_FIELDS).
		const touchedCapabilityFields = agentUnreachableCapabilityFieldsTouched(
			context.authType,
			data,
		);
		if (touchedCapabilityFields.length > 0) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`Capability/policy field(s) [${touchedCapabilityFields.join(", ")}] require a human operator or an operator-issued API key — no other caller identity, including an agent-authenticated tedi, an M2M client, or an internal service binding, can durably change a capability tier, even its own or another tedi's, regardless of its own granted scopes.`,
			);
		}

		if (
			data.toolPolicy !== undefined &&
			JSON.stringify(data.toolPolicy?.browserEgress ?? null) !==
				JSON.stringify(existingTedi.toolPolicy?.browserEgress ?? null) &&
			!canManageBrowserEgress(context.authType, context.userRole)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only organization admins can change browser egress",
			);
		}

		// Serialize JSON fields for D1 storage
		const updateData: Record<string, unknown> = {};
		let runtimeProfileRebind: string | undefined;
		if (data.name !== undefined) updateData.name = data.name;
		if (data.displayName !== undefined)
			updateData.displayName = data.displayName;
		if (data.externalRef !== undefined)
			updateData.externalRef = data.externalRef;
		if (data.tags !== undefined) {
			updateData.tags = data.tags ?? null;
		}
		if (data.personality !== undefined)
			updateData.personality = data.personality;
		if (data.avatar !== undefined) updateData.avatar = data.avatar;
		if (data.timezone !== undefined) updateData.timezone = data.timezone;
		if (data.language !== undefined) updateData.language = data.language;
		if (data.status !== undefined) updateData.status = data.status;
		if (data.billingState !== undefined)
			updateData.billingState = data.billingState;
		if (data.workerName !== undefined) updateData.workerName = data.workerName;
		if (data.r2BucketName !== undefined)
			updateData.r2BucketName = data.r2BucketName;
		if (data.toolPolicy !== undefined) updateData.toolPolicy = data.toolPolicy;
		if (data.selfImprovementPolicy !== undefined)
			updateData.selfImprovementPolicy = data.selfImprovementPolicy;
		if (data.budgets !== undefined) updateData.budgets = data.budgets;
		if (data.quietHours !== undefined) updateData.quietHours = data.quietHours;
		if (data.channels !== undefined) {
			// Extract bot tokens from channels and save as encrypted secrets.
			// Tokens are the single source of truth in tedi_secrets, not in the
			// channels column. Strip botToken/appToken before persisting to D1.
			const channelsObj = data.channels as Record<
				string,
				Record<string, unknown>
			> | null;
			const masterKey = context.env.SECRETS_MASTER_KEY;
			if (channelsObj && masterKey) {
				const tokenMappings: Array<{
					channel: string;
					field: string;
					secretName: string;
				}> = [
					{
						channel: "telegram",
						field: "botToken",
						secretName: "TELEGRAM_BOT_TOKEN",
					},
				];
				for (const { channel, field, secretName } of tokenMappings) {
					const channelConfig = channelsObj[channel];
					if (!channelConfig) continue;
					const tokenValue = channelConfig[field];
					if (
						typeof tokenValue === "string" &&
						tokenValue.length > 0 &&
						!tokenValue.includes("…")
					) {
						// Save as encrypted secret
						const encrypted = await encryptTediSecret(
							masterKey,
							tediId,
							tokenValue,
						);
						await upsertTediSecret(
							context.db,
							tediId,
							secretName,
							encrypted,
							null,
							null,
						);
						// Strip from channels object (don't store plaintext in D1)
						delete channelConfig[field];
					}
				}
			}
			updateData.channels = channelsObj;
		}
		if (data.cronJobs !== undefined) {
			const entitlement = await getRuntimeEntitlement(
				context.db,
				existingTedi.organizationId,
			);
			const maxCronJobs = entitlement?.limits.maxCronJobsPerTedi ?? 0;
			if (
				maxCronJobs >= 0 &&
				data.cronJobs !== null &&
				data.cronJobs.length > maxCronJobs
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`The ${entitlement?.profile.name ?? "current"} profile allows ${maxCronJobs} scheduled job(s) per tedi`,
				);
			}
			updateData.cronJobs = data.cronJobs;
		}
		if (data.installedSkills !== undefined)
			updateData.installedSkills = data.installedSkills;
		if (data.installedPlugins !== undefined)
			updateData.installedPlugins = data.installedPlugins;
		if (data.runtimeOverrides !== undefined)
			updateData.runtimeOverrides = data.runtimeOverrides ?? null;
		if (data.runtimeProfileId !== undefined) {
			// `null` resets to the system default; otherwise the profile must be a
			// system profile or one owned by this tedi's org (no cross-org binding).
			if (data.runtimeProfileId !== null) {
				const profile = await getRuntimeProfileById(
					context.db,
					data.runtimeProfileId,
				);
				if (
					!profile ||
					(profile.scope !== "system" &&
						profile.organizationId !== existingTedi.organizationId)
				) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`runtimeProfileId ${data.runtimeProfileId} is not a system profile or a runtime profile owned by this tedi's organization`,
					);
				}
			}
			runtimeProfileRebind =
				data.runtimeProfileId ??
				(await getSystemDefaultRuntimeProfile(context.db))?.id;
		}
		if (data.repoConfig !== undefined)
			updateData.repoConfig = data.repoConfig ?? null;
		if (data.mcpCapabilityProfile !== undefined)
			updateData.mcpCapabilityProfile = data.mcpCapabilityProfile;
		// NOTE: runtimeVersion is not stored on tedis — target version is set on
		// runtime_profiles, observed version flows via runtime_snapshots.

		const { actorId, actorType } = auditActor(context);
		if (
			runtimeProfileRebind !== undefined &&
			runtimeProfileRebind !== existingTedi.runtimeProfileId
		) {
			const rebound = await rebindTediControlPlaneRevision(context.db, {
				organizationId: existingTedi.organizationId,
				tediId,
				kind: "runtime_profile",
				expectedRevisionId: existingTedi.runtimeProfileId,
				revisionId: runtimeProfileRebind,
				changedBy: actorId,
				changeReason: "Tedi configuration update",
			});
			if (!rebound) {
				throw createError(
					ErrorCodes.CONFLICT,
					"The tedi runtime profile pin changed concurrently",
				);
			}
		}

		const tedi = await updateTedi(context.db, tediId, updateData);
		if (tedi)
			invalidateKernelContextCache(
				context,
				tedi.organizationId,
				"tedi.updated",
			);

		if (!tedi) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update tedi",
			);
		}

		// AI Gateway admission reads billing_inference_policies, not the tedi
		// configuration JSON. Keep an explicit per-tedi gateway policy authoritative
		// on the same operator mutation so displayed and enforced ceilings agree.
		if (data.budgets?.aiGatewayPolicy !== undefined) {
			await upsertTediInferencePolicy(context.db, {
				organizationId: existingTedi.organizationId,
				tediId,
				policy: data.budgets.aiGatewayPolicy,
			});
		}

		console.log(`[Tedis] Updated tedi: ${tedi.name} (${tediId})`);

		// Emit audit event for config change
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.config_change",
			resourceType: "tedi",
			resourceId: tediId,
			metadata: { fields: Object.keys(data) },
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.config_change:",
				err,
			);
		});

		// Fire-and-forget: invalidate tedi Worker resolve cache
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (provConfig) {
			const p = invalidateConfig(provConfig).catch(() => {});
			if (context.waitUntil) context.waitUntil(p);
		}

		// A capability-profile change alters the scopes each managed AIH M2M
		// client should hold, but client scopes are only re-derived on
		// assignment create/updateRole — not on a bare profile edit. Without
		// this, existing clients keep the old profile's scopes until an
		// unrelated assignment mutation. Re-materialize managed assignments so
		// the change propagates.
		//
		// The propagation guarantee is directional (audit CC-2):
		//  - Downgrade (fewer scopes) is security-critical — the client must shed
		//    the removed scopes. Run the re-sync synchronously and fail closed:
		//    if it fails, surface the error rather than reporting a clean success
		//    that leaves the client holding the old, broader scopes.
		//  - Upgrade / lateral / no-op only adds scope (or none), and the live D1
		//    profile already governs the MCP edge, so its re-sync stays
		//    best-effort + non-blocking and never gates the response.
		if (data.mcpCapabilityProfile !== undefined) {
			const isDowngrade = isTediCapabilityDowngrade(
				existingTedi.mcpCapabilityProfile,
				tedi.mcpCapabilityProfile,
			);
			if (isDowngrade) {
				try {
					await materializeManagedAppAssignments(context, tedi);
				} catch (err) {
					console.error(
						`[Tedis] Fail-closed AIH client re-sync after capability DOWNGRADE failed for ${tedi.slug}:`,
						err instanceof Error ? err.message : err,
					);
					throw createError(
						ErrorCodes.INTERNAL_SERVER_ERROR,
						`The capability profile was reduced in D1, but propagating the reduced scopes to this tedi's Descope AIH client(s) failed — a managed client may still hold the previous, broader scopes. Retry the update to re-sync. (${err instanceof Error ? err.message : String(err)})`,
					);
				}
			} else {
				const resync = materializeManagedAppAssignments(context, tedi).catch(
					(err) =>
						console.warn(
							`[Tedis] AIH client re-sync after profile change failed for ${tedi.slug}:`,
							err instanceof Error ? err.message : err,
						),
				);
				if (context.waitUntil) context.waitUntil(resync);
			}
		}

		return toTediDto(tedi);
	});

// =============================================================================
// governance override
// =============================================================================

/**
 * Set (or clear) a per-tedi `governanceOverride` so a delegated CTO can flip
 * a tedi between gated and autonomous without mutating shared policy packs.
 *
 * Auth: a tedi administrator plus organization-scoped ownership of the target.
 * This lets a tenant operate its own delegation posture without granting it
 * cross-tenant platform authority. The target lookup remains scoped to the
 * caller's organization, and dispatch retains its independent risk gates.
 *
 * The change flows into `deriveRequiresApproval` immediately on the next
 * capability card assembly — no cache invalidation needed (the capability
 * cards are assembled per-turn from D1).
 *
 * An `audit_events` row is written and awaited so the governance change is
 * reliably persisted to the audit trail. (Fire-and-forget dropped events under
 * concurrent writes — the Worker tore down before the promise resolved.) A
 * transient write failure is logged but does not roll back the already-applied
 * governance change.
 */
export const updateTediGovernanceProcedure = authedTedisOs.updateGovernance
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		// Capture before-state for the audit trail.
		const before = tedi.governanceOverride ?? null;

		const override =
			input.requiresApproval === null
				? null
				: { requiresApproval: input.requiresApproval };

		const updated = await updateTedi(context.db, tedi.id, {
			governanceOverride: override,
		});
		invalidateKernelContextCache(
			context,
			tedi.organizationId,
			"tedi.governance_updated",
		);

		if (!updated) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update tedi governance override",
			);
		}

		const newOverride = updated.governanceOverride ?? null;
		const effectiveRequiresApproval =
			typeof newOverride?.requiresApproval === "boolean"
				? newOverride.requiresApproval
				: true; // fail-safe: unknown → gated

		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: tedi.organizationId,
			actorId,
			actorType,
			action: "tedi.governance.updated",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: {
				before,
				after: newOverride,
				requiresApproval: effectiveRequiresApproval,
				autonomy: effectiveRequiresApproval ? "gated" : "autonomous",
			},
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.governance.updated:",
				err,
			);
		});

		console.log(
			`[Tedis] Governance override set for ${tedi.name} (${tedi.id}): requiresApproval=${effectiveRequiresApproval}`,
		);

		return {
			tediId: tedi.id,
			slug: tedi.slug,
			governanceOverride: newOverride,
			requiresApproval: effectiveRequiresApproval,
			autonomy: (effectiveRequiresApproval ? "gated" : "autonomous") as
				| "gated"
				| "autonomous",
		};
	});
