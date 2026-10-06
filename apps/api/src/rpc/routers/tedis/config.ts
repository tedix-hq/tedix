/**
 * Tedis Router — Config sync, runtime projection
 */

import {
	getPolicyPackById,
	getRuntimeProfileById,
	getWorkspaceTemplateSetById,
} from "@tedix/db/queries/control-plane/definitions";
import { getCompiledPatterns } from "@tedix/db/queries/memory-graph/optimization-signals";
import {
	cleanupOldSnapshots,
	createRuntimeSnapshot,
	createUsageEvents,
	getLatestRuntimeSnapshot,
	listTediRuntimeMetaBySlugs,
	listUsageEvents,
	updateTediHeartbeat,
} from "@tedix/db/queries/tedis";
import { CLOUDFLARE_AUTO_MODEL_REF } from "@tedix/api-contract/schemas/model-catalog";
import { ModelGenerationPolicySchema } from "@tedix/api-contract/schemas/model-generation";
import type { ModelPolicy } from "@tedix/db/schema/control-plane";
import { resolveWorkspaceFiles } from "@tedix/context-core/tedi-workspace";
import { chatModelRefFromRuntimeOverrides } from "../../../lib/tedi-model-overrides";
import {
	AUTHZ,
	authedTedisOs,
	requireTediAccess,
	tedisOs,
	withServiceAuth,
} from "./helpers";

// =============================================================================
// CONFIG SYNC
// =============================================================================

export const syncConfig = authedTedisOs.syncConfig
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		// Fetch control-plane FKs for workspace projection.
		const [runtimeProfile, policyPack, templateSet, compiledPatterns] =
			await Promise.all([
				tedi.runtimeProfileId
					? getRuntimeProfileById(context.db, tedi.runtimeProfileId)
					: null,
				tedi.policyPackId
					? getPolicyPackById(context.db, tedi.policyPackId)
					: null,
				tedi.workspaceTemplateSetId
					? getWorkspaceTemplateSetById(context.db, tedi.workspaceTemplateSetId)
					: null,
				getCompiledPatterns(context.db, tedi.id),
			]);

		const resolved = resolveWorkspaceFiles(
			tedi,
			templateSet?.templates ?? null,
			policyPack?.definition ?? null,
			compiledPatterns.length > 0 ? compiledPatterns : null,
			null, // expertise — not fetched in API config sync
			runtimeProfile?.config?.evolutionStrategy ?? null,
		);
		const workspaceFiles = {
			"SOUL.md": resolved.workspaceFiles["SOUL.md"] ?? "",
			"IDENTITY.md": resolved.workspaceFiles["IDENTITY.md"] ?? "",
			"USER.md": resolved.workspaceFiles["USER.md"] ?? "",
			"AGENTS.md": resolved.workspaceFiles["AGENTS.md"] ?? "",
			"TOOLS.md": resolved.workspaceFiles["TOOLS.md"] ?? "",
			"MEMORY.md": resolved.workspaceFiles["MEMORY.md"] ?? "",
			"HEARTBEAT.md": resolved.platformFiles["HEARTBEAT.md"] ?? "",
		};

		console.log(
			`[Tedis] Workspace config generated for: ${tedi.name} (${input.tediId})`,
		);

		return {
			success: true,
			message: `Workspace config generated for ${tedi.name}: ${Object.keys(workspaceFiles).length} files`,
			workspaceFiles,
		};
	});

// =============================================================================
// MODEL POLICY (per-role chat model selection)
// =============================================================================

/** Non-empty string, else `null` — the shape the runtime consumes. */
function policyRefOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve a tedi's per-role model policy. Precedence for `chatModelRef`:
 *
 *   1. Per-tedi override — `runtimeOverrides.agents.defaults.model.primary`,
 *      normalized to a canonical catalog ref (Tedix OS model setting).
 *   2. Runtime profile policy —
 *      `runtime_profile_id → runtime_profiles.config.modelPolicy.chatModelRef`.
 *   3. `null` → the runtime's env default deployment.
 *
 * The per-surface refs (`cronModelRef`, `observerModelRef`) come only from the
 * runtime profile: a per-tedi override is a whole-tedi pin, so it deliberately
 * returns null surface refs and every surface resolves onto the pin through the
 * runtime's fallback chain — exactly what a per-tedi override does today.
 *
 * Read by the tedi runtime DO to pick this role's model. Read-only +
 * tedi-scoped; the runtime calls it over the service binding (org="system").
 */
export const getModelPolicy = authedTedisOs.getModelPolicy
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const overrideRef = chatModelRefFromRuntimeOverrides(tedi.runtimeOverrides);
		const runtimeProfile = tedi.runtimeProfileId
			? await getRuntimeProfileById(context.db, tedi.runtimeProfileId)
			: null;
		const modelPolicy = runtimeProfile?.config?.modelPolicy as
			| ModelPolicy
			| undefined;
		return {
			chatModelRef:
				overrideRef ??
				policyRefOrNull(modelPolicy?.chatModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF,
			cronModelRef:
				overrideRef ??
				policyRefOrNull(modelPolicy?.cronModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF,
			observerModelRef:
				overrideRef ??
				policyRefOrNull(modelPolicy?.observerModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF,
			...(modelPolicy?.generation === undefined
				? {}
				: {
						generation: ModelGenerationPolicySchema.parse(
							modelPolicy.generation,
						),
					}),
		};
	});

// =============================================================================
// RUNTIME PROJECTION
// =============================================================================

export const getRuntimeProjection = authedTedisOs.getRuntimeProjection
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const snapshot = await getLatestRuntimeSnapshot(context.db, input.tediId);
		const usageEvents = await listUsageEvents(context.db, input.tediId, 50);

		return {
			snapshot: snapshot ?? null,
			usageEvents,
		};
	});

export const ingestRuntimeProjection = tedisOs.ingestRuntimeProjection
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const nowIso = new Date().toISOString();
		const observedAt = input.observedAt ?? nowIso;
		const runtimeStatus = input.runtimeStatus;

		const channelStatus = input.channelStatus
			? Object.fromEntries(
					input.channelStatus.map((c: { channel: string }) => [c.channel, c]),
				)
			: null;
		const deviceStatus = input.devices
			? {
					pending: input.devices.filter(
						(d: { status: string }) => d.status === "pending",
					),
					paired: input.devices.filter(
						(d: { status: string }) => d.status === "paired",
					),
					revoked: input.devices.filter(
						(d: { status: string }) => d.status === "revoked",
					),
				}
			: null;

		const snapshot = await createRuntimeSnapshot(context.db, {
			id: crypto.randomUUID(),
			tediId: input.tediId,
			source: input.source,
			runtimeStatus: runtimeStatus ?? null,
			runtimeVersion: input.runtimeVersion ?? null,
			channelStatus: channelStatus ?? null,
			deviceStatus: deviceStatus ?? null,
			observedAt,
		});

		const usageRows =
			input.usageEvents?.map(
				(event: {
					eventType: string;
					startedAt: string;
					endedAt?: string | null;
					durationMs?: number | null;
					units?: number | null;
					metadata?: Record<string, unknown> | null;
				}) => ({
					id: crypto.randomUUID(),
					tediId: input.tediId,
					eventType: event.eventType,
					startedAt: event.startedAt,
					endedAt: event.endedAt ?? null,
					durationMs: event.durationMs ?? null,
					units: event.units ?? null,
					metadata: event.metadata ?? null,
				}),
			) ?? [];
		await createUsageEvents(context.db, usageRows);

		// NOTE: this used to also ingest `token_snapshot` usage events into a
		// cumulative per-tedi cost ledger (a runtime-scraper pipeline, since
		// removed). Call costs are now ingested directly
		// from AI Gateway logs (apps/api/src/jobs/gateway-cost-ingestion.ts).
		// Settled billable overage is exported asynchronously through the
		// canonical billing ledger + Stripe outbox in billing-metering.ts.

		// Keep the tedis table in sync — this was the missing link between
		// runtime projection snapshots and the canonical tedi record.
		// The cron calls ingestRuntimeProjection but never called heartbeat,
		// so runtimeStatus and lastSeenAt on the tedis table stayed stale.
		if (runtimeStatus) {
			const normalizedRuntimeStatus =
				runtimeStatus === "stopped" ? "sleeping" : runtimeStatus;
			// Derive billing state from runtime status:
			// running → active, stopped/sleeping → warm (cron reached it), else cold
			const billingState: "cold" | "warm" | "active" =
				normalizedRuntimeStatus === "running"
					? "active"
					: normalizedRuntimeStatus === "sleeping"
						? "warm"
						: "cold";

			await updateTediHeartbeat(context.db, input.tediId, {
				runtimeStatus: normalizedRuntimeStatus,
				lastSyncAt: observedAt,
				billingState,
				observedAt,
				preserveFreshStart: true,
			});
		}

		return {
			ok: true,
			snapshotId: snapshot.id,
			usageEventCount: usageRows.length,
		};
	});

// =============================================================================
// RUNTIME METADATA (batched, cross-org, service-binding only)
// =============================================================================

// Batched runtime-kind/identity lookup by globally-unique slug for the MCP
// aggregate edge. Service-binding only (withServiceAuth) and cross-org by
// design — slugs are globally unique, and the edge holds only slugs. Returns
// the raw projection; the caller owns the inactive-tedi drop + fail-safe
// semantics so this endpoint stays a pure read.
export const listRuntimeMetaBySlugs = tedisOs.listRuntimeMetaBySlugs
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const data = await listTediRuntimeMetaBySlugs(context.db, input.slugs);
		return { data };
	});

// =============================================================================
// SNAPSHOT CLEANUP
// =============================================================================

export const cleanupSnapshots = tedisOs.cleanupSnapshots
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const deletedCount = await cleanupOldSnapshots(
			context.db,
			input.olderThanDays,
		);
		return { ok: true, deletedCount };
	});
