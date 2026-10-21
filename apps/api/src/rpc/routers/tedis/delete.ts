import { deleteMcpServerRegistration } from "../../../lib/provider-facts-cache";
import { getManagementClient } from "@tedix/auth/client";
import { getAssignedAppRoles, revokeAppAccess } from "@tedix/auth/fga";
import {
	deleteTediIdentity,
	TEDI_LOGIN_PREFIX,
} from "@tedix/auth/tedi-identity";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getTediById, retireTedi } from "@tedix/db/queries/tedis";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	withAuthorization,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	requireOrganizationId,
} from "./helpers";

/**
 * One structured outcome row from a tedi teardown sub-cleanup. `ok: false` never
 * aborts the cascade — purge is best-effort per external system and the caller
 * reports the failed steps rather than leaving the tedi half-deleted.
 */
export interface TediCleanupResult {
	step: string;
	ok: boolean;
	detail?: string;
}

/**
 * Tear down a tedi's external identity footprint (Descope user, FGA app
 * relations, AIH MCP server registration). Shared by `deleteTediProcedure` and
 * the platform-admin `decommissionTediProcedure` hard-purge path so the supported
 * cleanup lives in exactly one place. Best-effort and fail-soft per system:
 * returns a structured result per step instead of throwing, so D1 deletion still
 * proceeds even if a remote call fails.
 */
export async function purgeTediExternalIdentity(
	context: BaseContext,
	tedi: {
		name: string;
		slug: string | null;
		organizationId: string;
		descopeUserId: string | null;
		descopeMcpResourceId: string | null;
	},
): Promise<TediCleanupResult[]> {
	const results: TediCleanupResult[] = [];

	// Clean up Descope identity + FGA relations before D1 deletion
	if (tedi.descopeUserId && context.env.DESCOPE_MANAGEMENT_KEY) {
		try {
			const descopeClient = getManagementClient(context.env);

			// Revoke all FGA app relations for this tedi
			try {
				const orgApps = await getAppsByOrganization(
					context.db,
					tedi.organizationId,
				);
				const roles = await getAssignedAppRoles(
					descopeClient,
					tedi.descopeUserId,
					orgApps.map((a) => a.id),
				);
				const assignedAppIds = Object.keys(roles);
				for (const appId of assignedAppIds) {
					await revokeAppAccess(descopeClient, tedi.descopeUserId, appId);
				}
				console.log(
					`[Tedis] Revoked ${assignedAppIds.length} FGA relations for tedi ${tedi.name}`,
				);
				results.push({
					step: "descope_fga_revoke",
					ok: true,
					detail: `revoked ${assignedAppIds.length} app relations`,
				});
			} catch (fgaError) {
				console.warn(
					`[Tedis] Failed to revoke FGA relations for tedi ${tedi.name}:`,
					fgaError,
				);
				results.push({
					step: "descope_fga_revoke",
					ok: false,
					detail:
						fgaError instanceof Error ? fgaError.message : String(fgaError),
				});
			}

			// Delete the Descope user (cascades access keys)
			const loginId = `${TEDI_LOGIN_PREFIX}${tedi.slug}`;
			await deleteTediIdentity(descopeClient, loginId);
			console.log(
				`[Tedis] Deleted Descope identity for tedi ${tedi.name} (user: ${tedi.descopeUserId})`,
			);
			results.push({
				step: "descope_identity_delete",
				ok: true,
				detail: `deleted user ${tedi.descopeUserId}`,
			});
		} catch (error) {
			console.warn(
				`[Tedis] Failed to clean up Descope identity for tedi ${tedi.name}:`,
				error,
			);
			results.push({
				step: "descope_identity_delete",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	} else {
		results.push({
			step: "descope_identity_delete",
			ok: true,
			detail: "skipped — no Descope identity or management key configured",
		});
	}

	// Clean up Descope AIH MCP server registration
	if (tedi.descopeMcpResourceId && context.env.DESCOPE_MANAGEMENT_KEY) {
		try {
			await deleteMcpServerRegistration(context.env, tedi.descopeMcpResourceId);
			console.log(
				`[Tedis] Deleted AIH MCP server for tedi ${tedi.name} (serverId: ${tedi.descopeMcpResourceId})`,
			);
			results.push({ step: "descope_aih_mcp_delete", ok: true });
		} catch (error) {
			console.warn(
				`[Tedis] Failed to delete AIH MCP server for tedi ${tedi.name}:`,
				error,
			);
			results.push({
				step: "descope_aih_mcp_delete",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

/**
 * May the caller delete a tedi that lives in `tediOrgId`?
 *
 * Same-org delete is the ordinary case and is unchanged. Deleting a tedi in a
 * different org is a cross-org write and requires platform-admin authority —
 * that is what makes tenant OFFBOARDING automatable, mirroring the cross-org
 * `tedis.create` that made ONBOARDING automatable (`resolveTediCreateOrg`).
 * Without it a platform admin had to interactively `tedix login <customer>` to
 * tear a customer's tedis down, so offboarding could not be scripted at all.
 *
 * Authority is checked with `isPlatformPrincipal` (not `isPlatformAdmin`), so
 * API-key/M2M automation and the `platform:admin` CTO tedi count — a tedi's Descope
 * roles are not in its JWT, so a role-only check silently rejects them.
 *
 * Fail-closed: a non-platform caller is still confined to its own org.
 *
 * This deliberately does not relax the shared `requireTediAccess` guard, which
 * ~19 other routers (get/update/runtime/sessions/secrets/...) rely on for org
 * isolation. Only the delete path gains cross-org reach.
 */
export function resolveTediDeleteAccess(params: {
	callerOrgId: string;
	tediOrgId: string;
	isPlatformPrincipal: boolean;
}): { allowed: boolean; crossOrg: boolean } {
	const crossOrg = params.tediOrgId !== params.callerOrgId;
	if (!crossOrg) return { allowed: true, crossOrg: false };
	return {
		allowed: params.isPlatformPrincipal,
		crossOrg: true,
	};
}

/**
 * Load the tedi targeted by a delete and enforce {@link resolveTediDeleteAccess}.
 *
 * Returns the TEDI's own row — every downstream cleanup step must key off
 * `tedi.organizationId`, never the caller's org, or a cross-org delete would
 * purge the wrong tenant's footprint.
 */
export async function requireTediDeleteAccess(
	context: BaseContext,
	tediId: string,
) {
	const callerOrgId = requireOrganizationId(context);
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	const { allowed, crossOrg } = resolveTediDeleteAccess({
		callerOrgId,
		tediOrgId: tedi.organizationId,
		isPlatformPrincipal: isPlatformPrincipal(context),
	});

	if (!allowed) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}

	if (crossOrg) {
		console.log(
			`[Auth] Cross-org tedi delete: actor=${context.user?.sub ?? context.tediId ?? context.authType} tedi=${tediId} (org=${tedi.organizationId}, caller-org=${callerOrgId})`,
		);
	}

	return tedi;
}

/**
 * Retire a tedi.
 *
 * `DELETE /tedis/{tediId}` deliberately does not delete the row. Every
 * tediId-scoped table is `ON DELETE CASCADE`, so the D1 delete used to destroy
 * memory_facts, tedi_rationale_records, tedi_artifacts, tedi_runtime_events,
 * skill_entries/skill_runs, tedi_expertise, tedi_growth_snapshots and
 * tedi_entrustment_grants — the customer-owned cognitive state
 * that must survive the worker. Retiring stops the worker
 * (external identity purged, runtime archived, slug freed for a replacement)
 * while leaving that memory in D1, queryable by the retired tedi's id.
 *
 * The irreversible cascade still exists as `tedis.decommission` with
 * `hardPurge` + a matching `confirmSlug`, which is platform-admin-only.
 */
export const deleteTediProcedure = authedTedisOs.delete
	.use(withAuthorization("tedis:delete", "apps:delete"))
	.handler(async ({ input, context }) => {
		// A tedi is the durable worker asset — identity, memory, ledger.
		// Confirm the retirement in the OS; this server gate still checks
		// caller authority and tenant ownership for every caller.
		const tedi = await requireTediDeleteAccess(context, input.tediId);

		// Already retired — report it honestly instead of purging the external
		// identity a second time or restamping the retirement.
		if (tedi.retiredAt) {
			return {
				success: true as const,
				message: `Tedi "${tedi.name}" was already retired at ${tedi.retiredAt}`,
			};
		}

		// Clean up Descope identity + FGA relations + AIH MCP server. The worker
		// must stop being able to authenticate immediately; all three are
		// re-creatable, unlike its memory. Keyed on `tedi.organizationId` inside —
		// the tedi's own org, which is not necessarily the caller's on a
		// platform-admin cross-org retire.
		await purgeTediExternalIdentity(context, tedi);

		// The TEDI's org — NOT the caller's. On a cross-org retire the caller's org
		// is a different tenant, and stamping it here would file the offboarding
		// audit event against the wrong organization and leave the owning tenant's
		// audit trail with no record that its tedi was retired.
		const orgId = tedi.organizationId;

		const retiredAt = new Date().toISOString();
		const retired = await retireTedi(context.db, {
			tediId: input.tediId,
			retiredAt,
		});
		if (!retired) {
			// The CAS lost: another caller retired this tedi between the read above
			// and this write. Do not claim a retirement this request did not make.
			throw createError(
				ErrorCodes.CONFLICT,
				`Tedi "${tedi.name}" was retired concurrently by another request`,
			);
		}

		console.log(
			`[Tedis] Retired tedi: ${tedi.name} (${input.tediId}); memory retained, slug ${tedi.slug} released`,
		);

		// Emit audit event for tedi retirement.
		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: orgId,
			actorId,
			actorType,
			action: "tedi.retire",
			resourceType: "tedi",
			resourceId: input.tediId,
			metadata: {
				name: tedi.name,
				slug: tedi.slug,
				retiredAt: retired.retiredAt,
				retiredSlug: retired.retiredSlug,
				memoryRetained: true,
			},
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.retire:", err);
		});

		return {
			success: true as const,
			message: `Tedi "${tedi.name}" has been retired. Its memory, rationale, skills and artifacts are retained; a platform-admin hard purge is required to destroy them.`,
		};
	});
