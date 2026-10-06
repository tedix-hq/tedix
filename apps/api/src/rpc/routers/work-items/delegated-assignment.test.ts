import { describe, expect, it } from "vite-plus/test";
import {
	findAssignedActiveAttempt,
	isAssignedTediExecutor,
} from "./delegated-assignment";

describe("delegated assigned Work execution", () => {
	it("accepts only the accountable tedi", () => {
		expect(
			isAssignedTediExecutor({
				accountableOwnerType: "tedi",
				accountableOwnerId: "cto",
				executorType: "tedi",
				executorId: "cto",
			}),
		).toBe(true);
		expect(
			isAssignedTediExecutor({
				accountableOwnerType: "tedi",
				accountableOwnerId: "cto",
				executorType: "tedi",
				executorId: "cfo",
			}),
		).toBe(false);
		expect(
			isAssignedTediExecutor({
				accountableOwnerType: "user",
				accountableOwnerId: "cto",
				executorType: "tedi",
				executorId: "cto",
			}),
		).toBe(false);
		expect(
			isAssignedTediExecutor({
				accountableOwnerType: "tedi",
				accountableOwnerId: "cto",
				executorType: "external_agent",
				executorId: "cto",
			}),
		).toBe(false);
	});

	it("recovers only the assigned tedi's authoritative active attempt", () => {
		const active = {
			id: "active",
			executorType: "tedi",
			executorId: "cto",
			runtimeState: "running",
			expiresAt: "2026-09-02T21:00:00.000Z",
		};
		expect(
			findAssignedActiveAttempt(
				[{ ...active, id: "other", executorId: "cfo" }, active],
				"cto",
				"2026-09-02T20:00:00.000Z",
			),
		).toEqual(active);
		expect(
			findAssignedActiveAttempt(
				[{ ...active, runtimeState: "failed" }],
				"cto",
				"2026-09-02T20:00:00.000Z",
			),
		).toBeNull();
		for (const invalid of [
			{ ...active, expiresAt: null },
			{ ...active, expiresAt: "2026-09-02T20:00:00.000Z" },
			{ ...active, executorType: "external_agent" },
			{ ...active, executorId: "cfo" },
		]) {
			expect(
				findAssignedActiveAttempt([invalid], "cto", "2026-09-02T20:00:00.000Z"),
			).toBeNull();
		}
		expect(
			findAssignedActiveAttempt(
				[{ ...active, expiresAt: "2026-09-02T19:00:00.000Z" }],
				"cto",
				"2026-09-02T20:00:00.000Z",
			),
		).toBeNull();
	});
});
