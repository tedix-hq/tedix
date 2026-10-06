/// <reference path="../../worker-configuration.d.ts" />
/**
 * 9am UTC cost-anomaly check (per-tedi + platform aggregate + digest alert),
 * owned by this module. The dispatcher keeps the hour === 9 gate.
 */

export async function runCostAnomalyCheck(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Running cost anomaly check (${runId})`);
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const { getDailySpendRate } = await import("@tedix/db/queries/tedi-usage");
		const { listOrganizations } =
			await import("@tedix/db/queries/organizations");
		const { getTedisByOrganization } = await import("@tedix/db/queries/tedis");
		const db = createDbClient(env.DB);

		let checked = 0;
		let warnings = 0;
		// Collected for a single best-effort digest email at the end (below).
		const anomalies: Array<{
			scope: "platform" | "tedi";
			label: string;
			daily_usd: number;
			sevenDayAvgDailyUsd: number;
			anomaly_score: number;
			daily_calls: number;
			topModel?: string;
		}> = [];

		// Platform aggregate (tediId = null)
		try {
			const platform = await getDailySpendRate(db, null, 1);
			checked++;
			if (platform.anomaly_score === null) {
				warnings++;
				console.error(
					JSON.stringify({
						signal: "tedi.cost.unpriced",
						scope: "platform",
						knownSubtotalUsd: platform.knownSubtotalUsd,
						unpricedCalls: platform.unpricedCalls,
						baselineUnpricedCalls: platform.baselineUnpricedCalls,
						message:
							"Cost comparison unavailable because provider usage is unpriced",
					}),
				);
			}
			if (
				platform.anomaly_score !== null &&
				platform.anomaly_score >= 0.5 &&
				platform.daily_usd !== null &&
				platform.sevenDayAvgDailyUsd !== null
			) {
				warnings++;
				anomalies.push({
					scope: "platform",
					label: "Platform",
					daily_usd: platform.daily_usd,
					sevenDayAvgDailyUsd: platform.sevenDayAvgDailyUsd,
					anomaly_score: platform.anomaly_score,
					daily_calls: platform.daily_calls,
					topModel: platform.models[0]?.model,
				});
				console.warn(
					JSON.stringify({
						signal: "tedi.cost.anomaly",
						scope: "platform",
						tediId: null,
						asOf: platform.asOf,
						daily_usd: Number(platform.daily_usd.toFixed(4)),
						daily_calls: platform.daily_calls,
						// Reported beside spend, never inside it. `daily_usd` now
						// excludes quarantined rows; emitting the held-out portion
						// keeps the opposite failure visible, because a detector that
						// simply went quiet because pricing broke looks identical to
						// one with nothing to report.
						quarantined_usd: Number(platform.quarantined_usd.toFixed(4)),
						quarantined_calls: platform.quarantined_calls,
						sevenDayAvgDailyUsd: Number(
							platform.sevenDayAvgDailyUsd.toFixed(4),
						),
						anomaly_score: platform.anomaly_score,
						topModels: platform.models.slice(0, 3).map((m) => ({
							model: m.model,
							cost_usd:
								m.cost_usd === null ? null : Number(m.cost_usd.toFixed(4)),
							calls: m.calls,
						})),
						message:
							platform.anomaly_score === 1
								? "Platform daily spend > 3x 7-day avg"
								: "Platform daily spend > 2x 7-day avg",
					}),
				);
			}
		} catch (platformErr) {
			console.warn(
				`[Scheduled] Cost anomaly platform check failed:`,
				platformErr,
			);
		}

		// Per-tedi
		const orgs = await listOrganizations(db);
		for (const org of orgs) {
			const orgTedis = await getTedisByOrganization(db, org.id);
			for (const tedi of orgTedis) {
				if (tedi.status === "paused") continue;
				try {
					const rate = await getDailySpendRate(db, tedi.id, 1);
					checked++;
					if (rate.anomaly_score === null) {
						warnings++;
						console.error(
							JSON.stringify({
								signal: "tedi.cost.unpriced",
								scope: tedi.id,
								knownSubtotalUsd: rate.knownSubtotalUsd,
								unpricedCalls: rate.unpricedCalls,
								baselineUnpricedCalls: rate.baselineUnpricedCalls,
								message:
									"Cost comparison unavailable because provider usage is unpriced",
							}),
						);
					}
					if (
						rate.anomaly_score !== null &&
						rate.anomaly_score >= 0.5 &&
						rate.daily_usd !== null &&
						rate.sevenDayAvgDailyUsd !== null
					) {
						warnings++;
						anomalies.push({
							scope: "tedi",
							label: `Tedi ${tedi.slug}`,
							daily_usd: rate.daily_usd,
							sevenDayAvgDailyUsd: rate.sevenDayAvgDailyUsd,
							anomaly_score: rate.anomaly_score,
							daily_calls: rate.daily_calls,
							topModel: rate.models[0]?.model,
						});
						console.warn(
							JSON.stringify({
								signal: "tedi.cost.anomaly",
								scope: "tedi",
								tediId: tedi.id,
								tediSlug: tedi.slug,
								orgId: org.id,
								asOf: rate.asOf,
								daily_usd: Number(rate.daily_usd.toFixed(4)),
								daily_calls: rate.daily_calls,
								sevenDayAvgDailyUsd: Number(
									rate.sevenDayAvgDailyUsd.toFixed(4),
								),
								anomaly_score: rate.anomaly_score,
								topModels: rate.models.slice(0, 3).map((m) => ({
									model: m.model,
									cost_usd:
										m.cost_usd === null ? null : Number(m.cost_usd.toFixed(4)),
									calls: m.calls,
								})),
								message:
									rate.anomaly_score === 1
										? `Tedi ${tedi.slug} daily spend > 3x 7-day avg`
										: `Tedi ${tedi.slug} daily spend > 2x 7-day avg`,
							}),
						);
					}
				} catch (tediErr) {
					console.warn(
						`[Scheduled] Cost anomaly check failed for tedi ${tedi.id}:`,
						tediErr,
					);
				}
			}
		}

		// Container spend, platform-wide. `getDailySpendRate` reads only
		// `tedi_call_costs`, so every non-token compute class was invisible here
		// — including workstation containers, where a leaked lease burns money
		// with no conversation to attribute it to. Platform scope only: a
		// container is charged to the account, and per-tedi attribution is
		// already carried on the ledger rows for drill-down.
		try {
			const { getDailyProviderUnitSpend } =
				await import("@tedix/db/queries/billing/provider-usage");
			const container = await getDailyProviderUnitSpend(db, {
				usageKind: "workstation_compute",
			});
			checked++;
			if (container.anomalyScore >= 0.5) {
				warnings++;
				const dailyUsd = container.dailyMicros / 1_000_000;
				const baselineUsd = container.sevenDayAvgDailyMicros / 1_000_000;
				anomalies.push({
					anomaly_score: container.anomalyScore,
					daily_calls: 0,
					daily_usd: dailyUsd,
					label: "Platform workstation containers",
					scope: "platform",
					sevenDayAvgDailyUsd: baselineUsd,
				});
				console.warn(
					JSON.stringify({
						anomaly_score: container.anomalyScore,
						asOf: container.asOf,
						computeSeconds: container.dailyQuantity,
						daily_usd: Number(dailyUsd.toFixed(4)),
						message:
							container.anomalyScore === 1
								? "Workstation container spend > 3x 7-day avg"
								: "Workstation container spend > 2x 7-day avg",
						scope: "platform",
						sevenDayAvgDailyUsd: Number(baselineUsd.toFixed(4)),
						signal: "tedi.cost.anomaly",
						usageKind: "workstation_compute",
					}),
				);
			}
		} catch (containerErr) {
			console.warn(
				"[Scheduled] Container cost anomaly check failed:",
				containerErr,
			);
		}

		// Best-effort digest alert: one dispatch per run (never per-tedi
		// flood) when anomalies fired. Delivered via the shared multi-channel
		// egress — each channel self-gates (empty COST_ALERT_EMAIL /
		// HEALTH_ALERT_WEBHOOK = no-op), so the webhook backstop fires even
		// without an email recipient; try/catch keeps it from breaking the cron.
		if (anomalies.length > 0) {
			try {
				const { sendOpsAlert } = await import("../lib/ops-alert-egress");
				const sorted = [...anomalies].sort(
					(a, b) => b.anomaly_score - a.anomaly_score,
				);
				const bodyLines = sorted
					.map(
						(a) =>
							`${a.anomaly_score === 1 ? "CRITICAL (>3x)" : "WARN (>2x)"} ${a.label}: ` +
							`$${a.daily_usd.toFixed(2)}/day vs $${a.sevenDayAvgDailyUsd.toFixed(2)} 7-day avg ` +
							`(${a.daily_calls} calls${a.topModel ? `, top model ${a.topModel}` : ""})`,
					)
					.join("\n");
				await sendOpsAlert(env, {
					subject: `[Tedix] ${anomalies.length} cost anomal${anomalies.length === 1 ? "y" : "ies"} detected (${sorted[0]?.label ?? "unknown scope"})`,
					text:
						`Daily cost anomaly check flagged ${anomalies.length} scope(s) at ` +
						`${new Date().toISOString()}:\n\n${bodyLines}\n\n` +
						`Thresholds: WARN = daily spend > 2x 7-day avg, CRITICAL = > 3x. ` +
						`Source: getDailySpendRate over D1 tedi usage.`,
					emailRecipients: env.COST_ALERT_EMAIL,
					webhookUrl: env.HEALTH_ALERT_WEBHOOK,
					fromName: "Tedix Cost Alerts",
					meta: { anomalyCount: anomalies.length, top: sorted[0] },
				});
			} catch (emailErr) {
				console.warn(
					`[Scheduled] Cost anomaly alert dispatch failed:`,
					emailErr,
				);
			}
		}

		console.log(
			`[Scheduled] Cost anomaly check complete: checked=${checked}, warnings=${warnings}`,
		);
		return { scopesChecked: checked, warnings };
	} catch (anomalyErr) {
		console.error(`[Scheduled] Cost anomaly check failed:`, anomalyErr);
		throw anomalyErr;
	}
}
