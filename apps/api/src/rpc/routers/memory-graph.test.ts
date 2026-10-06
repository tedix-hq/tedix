import { describe, expect, it } from "vite-plus/test";
import {
	resolveMemoryFactOwnership,
	resolveMemoryFactReviewUpdates,
} from "./memory-graph/policy-operations";

describe("resolveMemoryFactOwnership", () => {
	it("uses the forwarded unified-gateway tedi id for tedi-scoped memory", () => {
		expect(
			resolveMemoryFactOwnership({
				memoryScope: "tedi",
				forwardedTediId: "tedi-acme",
			}),
		).toEqual({ tediId: "tedi-acme", visibility: "private" });
	});

	it("rejects tedi-scoped memory without a concrete tedi owner", () => {
		expect(() => resolveMemoryFactOwnership({ memoryScope: "tedi" })).toThrow(
			"tedi-scoped memory requires a tediId",
		);
	});

	it("keeps org memory org-visible and unowned by a tedi", () => {
		expect(
			resolveMemoryFactOwnership({
				memoryScope: "org",
				forwardedTediId: "tedi-acme",
			}),
		).toEqual({ tediId: null, visibility: "org" });
	});
});

describe("resolveMemoryFactReviewUpdates", () => {
	const now = "2026-06-29T12:00:00.000Z";

	it("rejects noisy facts with safe recall defaults", () => {
		expect(
			resolveMemoryFactReviewUpdates(
				{ reviewStatus: "rejected", archived: true },
				{ now, reviewerTediId: "tedi-acme", reviewerAuthType: "service" },
			),
		).toMatchObject({
			reviewStatus: "rejected",
			usePolicy: "do_not_inject_automatically",
			priority: "background",
			archivedAt: now,
			metadata: {
				memoryLifecycle: {
					lastReview: {
						reviewedAt: now,
						reviewerTediId: "tedi-acme",
						reviewerAuthType: "service",
						reviewStatus: "rejected",
						archived: true,
					},
				},
			},
		});
	});

	it("preserves explicit lifecycle choices and existing metadata", () => {
		const updates = resolveMemoryFactReviewUpdates(
			{
				reviewStatus: "rejected",
				usePolicy: "requires_user_confirmation",
				priority: "active",
				reason: "Needs human review.",
			},
			{
				now,
				existingMetadata: {
					source: "smoke",
					memoryLifecycle: { previous: true },
				},
			},
		);

		expect(updates).toMatchObject({
			usePolicy: "requires_user_confirmation",
			priority: "active",
			metadata: {
				source: "smoke",
				memoryLifecycle: {
					previous: true,
					lastReview: {
						reason: "Needs human review.",
					},
				},
			},
		});
	});

	it("confirms facts as active and verified", () => {
		expect(
			resolveMemoryFactReviewUpdates({ reviewStatus: "confirmed" }, { now }),
		).toMatchObject({
			reviewStatus: "confirmed",
			status: "active",
			lastVerifiedAt: now,
		});
	});
});
