import { isPlatformPrincipal } from "@tedix/auth/types";
import { updateTedi } from "@tedix/db/queries/tedis";
import { invalidateConfig } from "@tedix/provisioning";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import {
	AUTHZ,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	getProvisioningConfig,
	requireTediAccess,
} from "./helpers";

// =============================================================================
// agent RUNTIME recovery
// =============================================================================

/**
 * Compute a fresh `isolate_agent_id` for a rebind.
 *
 * Convention: `{slug}-rebind-{epochMs}`. Guarantees the result differs from the
 * current value (guards the astronomically unlikely same-millisecond collision
 * by appending a short random suffix). Pure — no DB/auth — so it is unit
 * testable.
 */
export function computeRebindAgentId(args: {
	slug: string | null;
	id: string;
	currentIsolateAgentId: string | null;
	now?: number;
	randomSuffix?: () => string;
}): { isolateAgentId: string; previous: string } {
	const slugPart = args.slug ?? args.id;
	const previous = args.currentIsolateAgentId ?? slugPart;
	const epochMs = args.now ?? Date.now();
	let isolateAgentId = `${slugPart}-rebind-${epochMs}`;
	if (isolateAgentId === previous) {
		const suffix = (
			args.randomSuffix ?? (() => crypto.randomUUID().slice(0, 8))
		)();
		isolateAgentId = `${slugPart}-rebind-${epochMs}-${suffix}`;
	}
	return { isolateAgentId, previous };
}

/**
 * Assert the caller holds platform-admin authority or is a trusted service
 * binding. `` lets user JWTs bypass scope checks (RBAC
 * path), so Agent-runtime recovery procedures must re-check explicitly.
 * Fail-closed for ordinary org users.
 */
export function assertPlatformAdminOrServiceBinding(
	context: BaseContext,
): void {
	const isTrustedServiceBinding = context.authType === "service-binding";
	if (!isTrustedServiceBinding && !isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform admin authority required (user role 'platform-admin' or API key scope 'platform:admin')",
		);
	}
}

/**
 * Rebind core — repoint a wedged Agent-runtime tedi's `isolate_agent_id` to a
 * fresh Durable Object name and invalidate the edge resolve cache.
 *
 * The Agent runtime Worker addresses a tedi's DO via
 * `idFromName(tedis.isolate_agent_id)`. When that DO wedges (e.g. a poison
 * queued job persisted in its SQLite, which survives deploys), repointing
 * `isolate_agent_id` to a brand-new name routes future requests to a pristine
 * empty DO.
 *
 * This explicitly redirects future requests. The previous DO's persisted native
 * sessions, receipts, schedules and recovery state remain in that object and are
 * not transferred to the new name. A rebind does not recover that native state.
 * Caller must already hold platform-admin authority or a trusted service binding.
 */
export async function performRebindIsolate(
	context: BaseContext,
	tedi: Awaited<ReturnType<typeof requireTediAccess>>,
): Promise<{ isolateAgentId: string; previous: string }> {
	// Fresh-name convention: `{slug}-rebind-{epochMs}`. Date.now() is fine in
	// apps/api Workers.
	const { isolateAgentId, previous } = computeRebindAgentId({
		slug: tedi.slug,
		id: tedi.id,
		currentIsolateAgentId: tedi.isolateAgentId,
	});

	const updated = await updateTedi(context.db, tedi.id, { isolateAgentId });
	if (!updated) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Failed to rebind Agent-runtime tedi",
		);
	}

	console.log(
		`[Tedis] Rebound Agent-runtime tedi ${tedi.name} (${tedi.id}): ${previous} -> ${isolateAgentId}`,
	);

	const { actorId, actorType } = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId: tedi.organizationId,
		actorId,
		actorType,
		action: "tedi.rebind",
		resourceType: "tedi",
		resourceId: tedi.id,
		metadata: { previous, isolateAgentId },
	}).catch((err) => {
		console.error("[Tedis] Failed to emit audit event for tedi.rebind", {
			organizationId: tedi.organizationId,
			tediId: tedi.id,
			exception: safeExceptionTopology(err),
		});
	});

	// Fire-and-forget: invalidate the tedi edge Worker resolve cache so the
	// new isolate_agent_id takes effect immediately.
	const provConfig = getProvisioningConfig(updated, context.env);
	if (provConfig) {
		const p = invalidateConfig(provConfig).catch(() => {});
		if (context.waitUntil) context.waitUntil(p);
	}

	return { isolateAgentId, previous };
}

/**
 * Rebind a wedged Agent-runtime tedi to a fresh Durable Object name.
 *
 * Auth: platform-admin authority (user role `platform-admin`, or API-key/M2M
 * scope `platform:admin`) or a trusted service binding only. This is a
 * destructive-ish recovery operation, so it is fail-closed for normal users.
 */
export const rebindProcedure = authedTedisOs.rebind
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);

		const tedi = await requireTediAccess(context, input.tediId);

		const { isolateAgentId, previous } = await performRebindIsolate(
			context,
			tedi,
		);

		return { ok: true as const, isolateAgentId, previous };
	});
