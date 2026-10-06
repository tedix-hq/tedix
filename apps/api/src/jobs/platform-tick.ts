/// <reference path="../../worker-configuration.d.ts" />
/**
 * Two-minute platform tick sweeps. Each function owns one independently
 * observable maintenance domain behind lazy imports.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";

export async function dispatchGraphProjectionDrains(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const {
			getGraphProjectionCursor,
			listGraphProjectionCertificationOrganizations,
			listGraphProjectionOrganizations,
		} = await import("@tedix/db/queries/graph-projection");
		const {
			createGraphProjectionDrainBatch,
			selectGraphProjectionDispatchOrganizations,
		} = await import("../services/graph-projection-scheduling");
		const db = createDbClient(env.DB);
		const [backlogOrgIds, staleCertificationOrgIds] = await Promise.all([
			listGraphProjectionOrganizations(db, 20),
			listGraphProjectionCertificationOrganizations(
				db,
				new Date(event.scheduledTime - 5.75 * 60 * 60 * 1000).toISOString(),
				new Date(event.scheduledTime - 10 * 60 * 1000).toISOString(),
				5,
			),
		]);
		const orgIds = selectGraphProjectionDispatchOrganizations({
			backlogOrganizationIds: backlogOrgIds,
			recertificationOrganizationIds: staleCertificationOrgIds,
		});
		const retryBucket = Math.floor(event.scheduledTime / (10 * 60_000));
		const candidates = await Promise.all(
			orgIds.map(async (organizationId) => {
				const cursor = await getGraphProjectionCursor(db, organizationId);
				return { organizationId, cursor };
			}),
		);
		const admission = await createGraphProjectionDrainBatch(
			env.GRAPH_PROJECTION_DRAIN_WORKFLOW,
			candidates,
			retryBucket,
		);
		if (admission.candidates > 0) {
			console.log(
				"[Scheduled] graph projection drains",
				JSON.stringify({
					candidates: admission.candidates,
					backlogCandidates: backlogOrgIds.length,
					recertificationCandidates: staleCertificationOrgIds.length,
					started: admission.started,
					deduplicated: admission.deduplicated,
				}),
			);
		}
		return {
			candidates: admission.candidates,
			started: admission.started,
			deduplicated: admission.deduplicated,
		};
	} catch (error) {
		console.error(
			"[Scheduled] graph projection dispatch failed",
			safeExceptionTopology(error),
		);
		throw error;
	}
}

export async function redriveGraphGdsMaintenance(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const { reconcileStaleGraphGdsRefreshes } =
			await import("../services/graph-gds-maintenance-scheduling");
		const redrive = await reconcileStaleGraphGdsRefreshes({
			db: createDbClient(env.DB),
			binding: env.GRAPH_GDS_REFRESH_WORKFLOW,
			runtimeEnvironment: env.ENVIRONMENT,
			nowMs: event.scheduledTime,
		});
		if (redrive.candidates > 0 || redrive.failed > 0) {
			console.log(
				"[Scheduled] graph GDS maintenance redrive",
				JSON.stringify(redrive),
			);
		}
		return {
			candidates: redrive.candidates,
			created: redrive.created,
			existing: redrive.existing,
			settled: redrive.settled,
			failed: redrive.failed,
		};
	} catch (error) {
		console.error(
			"[Scheduled] graph GDS maintenance redrive failed",
			safeExceptionTopology(error),
		);
		throw error;
	}
}

export async function dispatchDueSkillSchedulesTick(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	try {
		const { dispatchDueSkillSchedules } =
			await import("../services/skill-scheduler");
		const scan = await dispatchDueSkillSchedules(env, event.scheduledTime);
		if (scan.due > 0 || scan.failed > 0) {
			console.log("[Scheduled] skill schedules", JSON.stringify(scan));
		}
		return {
			due: scan.due,
			dispatched: scan.dispatched,
			deduplicated: scan.deduplicated,
			failed: scan.failed,
			suppressed: scan.suppressed,
		};
	} catch (error) {
		console.error(
			"[Scheduled] skill schedule scan failed",
			safeExceptionTopology(error),
		);
		throw error;
	}
}

export async function runAlwaysOnKeepalive(
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const { getAlwaysOnTedis } = await import("@tedix/db/queries/tedis");
		const db = createDbClient(env.DB);
		const alwaysOn = await getAlwaysOnTedis(db);
		const tediSvc = env.TEDI_SERVICE;
		if (alwaysOn.length > 0) {
			console.log(
				`[Scheduled] alwaysOn-keepalive: probing ${alwaysOn.length} tedis (${alwaysOn.map((t) => t.slug).join(",")})`,
			);
			// Probe health synchronously (fast: ~hundreds of ms each).
			const probes = await Promise.allSettled(
				alwaysOn.map(async (t) => {
					const probeRes = await tediSvc
						.fetch(
							new Request(`https://${t.slug}.tedi.tedix.dev/health`, {
								method: "GET",
								headers: {
									"X-Tedix-Host": `${t.slug}.tedi.tedix.dev`,
									"X-Service-Binding": "true",
								},
							}),
						)
						.catch(() => null);
					const healthy =
						probeRes?.status === 200 &&
						(
							(await probeRes
								.clone()
								.json()
								.catch(() => ({}))) as {
								status?: string;
							}
						).status === "ok";
					return { slug: t.slug, healthy };
				}),
			);
			const unreachable = probes
				.filter(
					(
						r,
					): r is PromiseFulfilledResult<{
						slug: string;
						healthy: boolean;
					}> => r.status === "fulfilled" && !r.value.healthy,
				)
				.map((r) => r.value.slug);

			// Fire wake calls fire-and-forget via ctx.waitUntil. Wake takes ~25-30s
			// for cold boot (R2 mount + plugin runtime + gateway). The scheduled
			// handler's normal exit would cancel them at ~hundreds of ms, which is
			// what produced the `outcome: canceled, wallTimeMs: 683` in earlier
			// Workers Logs. waitUntil keeps the fetch alive up to the
			// scheduled-event budget (~6h) so each cold boot completes.
			for (const slug of unreachable) {
				ctx.waitUntil(
					tediSvc
						.fetch(
							new Request(
								`https://${slug}.tedi.tedix.dev/api/admin/status/wake`,
								{
									method: "POST",
									headers: {
										"X-Tedix-Host": `${slug}.tedi.tedix.dev`,
										"X-Service-Binding": "true",
									},
								},
							),
						)
						.then(async (res) => {
							if (res.status === 200) {
								console.log(
									`[Scheduled] alwaysOn-keepalive: wake ${slug} → 200`,
								);
								return;
							}
							console.warn(
								`[Scheduled] alwaysOn-keepalive: wake ${slug} → ${res.status}`,
							);
						})
						.catch((err) =>
							console.warn(
								`[Scheduled] alwaysOn-keepalive: wake ${slug} failed`,
								safeExceptionTopology(err),
							),
						),
				);
			}

			if (unreachable.length > 0) {
				console.log(
					`[Scheduled] alwaysOn-keepalive: dispatching wake for ${unreachable.length}/${alwaysOn.length}: ${unreachable.join(",")}`,
				);
			}
		}
	} catch (err) {
		console.warn(
			`[Scheduled] alwaysOn-keepalive failed (non-fatal)`,
			safeExceptionTopology(err),
		);
	}
}

export async function sweepOrphanRunsTick(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const { sweepOrphanRuns } =
			await import("../rpc/routers/cognitive-runtime/recovery-artifacts");
		const { propagateSweptChildFailureToHomeRun } =
			await import("../rpc/routers/kernel/run-store");
		const db = createDbClient(env.DB);
		// The Home-side writers only touch `context.db`; the scheduled tick has
		// no request, so a db-only context is the honest shape here.
		const homeContext = {
			db,
			env,
		} as unknown as import("../rpc/context").BaseContext;
		const result = await sweepOrphanRuns(db, {
			limit: 100,
			// A dropped delegated child must not leave its parent Home run and
			// delegation receipt saying "Running" forever: drive the parent through
			// the existing failure path. Sealed-as-success children are left to the
			// read-path reconcile, which relays the child's completed result.
			onSealed: (sealed) =>
				sealed.terminalKind === "run.failed"
					? propagateSweptChildFailureToHomeRun(homeContext, {
							organizationId: sealed.candidate.organizationId,
							delegatedTediId: sealed.candidate.tediId,
							childRunId: sealed.candidate.runId,
							message: sealed.message,
							failedAt: sealed.sealedAt,
						})
					: Promise.resolve(false),
		});
		if (result.swept > 0 || result.errors.length > 0) {
			console.log(
				`[Scheduled] orphan-run sweep: swept=${result.swept} propagated=${result.propagatedRunIds.length} skipped=${result.skipped} errors=${result.errors.length} runIds=${result.sweptRunIds.slice(0, 10).join(",")}${result.sweptRunIds.length > 10 ? "…" : ""}`,
			);
			// The sweep returns error strings that may contain run payloads or SQL.
			// The count and bounded run IDs above provide the safe correlation.
		}
		return {
			swept: result.swept,
			skipped: result.skipped,
			errors: result.errors.length,
		};
	} catch (err) {
		console.warn(
			`[Scheduled] orphan-run sweep failed (non-fatal)`,
			safeExceptionTopology(err),
		);
		throw err;
	}
}
