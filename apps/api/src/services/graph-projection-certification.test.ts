import { describe, expect, it } from "vite-plus/test";
import { graphProjectionReadAdmission } from "./graph-projection-certification";

const checkedAt = "2026-07-27T06:00:00.000Z";

function inspection(overrides: Record<string, unknown> = {}) {
	return {
		transportHealthy: true,
		checkedAt,
		readiness: {
			state: "ready" as const,
			reason: null,
			persistedWatermark: 12,
			gdsWatermark: 0,
			projectionEpoch: "generation-a",
			gdsEpoch: null,
			nodeMismatchCount: 0,
			edgeMismatchCount: 0,
			lifecycleMismatchCount: 0,
			repairId: "repair-1",
			repairPhase: "complete" as const,
			repairCursor: null,
			repairHighWater: 12,
			repairStartedAt: "2026-07-27T05:00:00.000Z",
			lastCertifiedAt: "2026-07-27T05:59:00.000Z",
		},
		backlog: {
			cursor: 12,
			highWaterSequence: 12,
			pendingCount: 0,
			retryCount: 0,
			poisonedCount: 0,
			oldestPendingAt: null,
		},
		...overrides,
	};
}

describe("graph projection read admission", () => {
	it("admits only a fresh, caught-up, certified projection", () => {
		expect(graphProjectionReadAdmission({ inspection: inspection() })).toEqual({
			allowed: true,
			reason: null,
		});
	});

	it("fails closed immediately when any canonical mutation is pending", () => {
		const current = inspection();
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					backlog: {
						...current.backlog,
						highWaterSequence: 13,
						pendingCount: 1,
						oldestPendingAt: "2026-07-27T05:59:59.000Z",
					},
				},
			}),
		).toEqual({ allowed: false, reason: "projection_backlog_pending" });
	});

	it("rejects transport-only health and stale certification", () => {
		expect(
			graphProjectionReadAdmission({
				inspection: inspection({ readiness: null }),
			}),
		).toEqual({ allowed: false, reason: "projection_not_certified" });
		const current = inspection();
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						lastCertifiedAt: "2026-07-26T20:00:00.000Z",
					},
				},
			}),
		).toEqual({ allowed: false, reason: "projection_certification_stale" });
	});

	it("separates persisted projection admission from GDS freshness", () => {
		expect(graphProjectionReadAdmission({ inspection: inspection() })).toEqual({
			allowed: true,
			reason: null,
		});
		expect(
			graphProjectionReadAdmission({
				inspection: inspection(),
				requiresGds: true,
			}),
		).toEqual({ allowed: false, reason: "gds_watermark_stale" });

		const current = inspection();
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						gdsWatermark: 12,
						gdsEpoch: "generation-a",
					},
				},
				requiresGds: true,
			}),
		).toEqual({ allowed: true, reason: null });
	});

	it("rejects a certified row whose persisted watermark drifted or generation is missing", () => {
		const current = inspection();
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						persistedWatermark: 11,
					},
				},
			}),
		).toEqual({ allowed: false, reason: "projection_watermark_mismatch" });
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						projectionEpoch: null,
					},
				},
			}),
		).toEqual({ allowed: false, reason: "projection_generation_missing" });
	});

	it("never admits an incomplete or uncaught-up baseline repair", () => {
		const current = inspection();
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						repairPhase: "facts",
					},
				},
			}),
		).toEqual({ allowed: false, reason: "baseline_repair_incomplete" });
		expect(
			graphProjectionReadAdmission({
				inspection: {
					...current,
					readiness: {
						...current.readiness,
						repairHighWater: 13,
					},
				},
			}),
		).toEqual({ allowed: false, reason: "baseline_repair_incomplete" });
	});
});
