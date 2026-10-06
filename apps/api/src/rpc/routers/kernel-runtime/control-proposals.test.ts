import { describe, expect, it } from "vite-plus/test";
import {
	delegationRetryState,
	recoverableDelegationWorkOrder,
} from "./control-proposals";

describe("delegationRetryState", () => {
	it("derives the ceiling from immutable attempt history", () => {
		expect(
			delegationRetryState({ retryCount: 0 }, [
				{ metadata: { retryCount: 2, failureReason: "dispatch_timeout" } },
				{ metadata: { retryCount: 1 } },
			]),
		).toEqual({
			latestAttemptMetadata: {
				retryCount: 2,
				failureReason: "dispatch_timeout",
			},
			retryCount: 2,
		});
	});

	it("never lets older Work Item metadata reset a higher retry count", () => {
		expect(
			delegationRetryState({ retryCount: 3 }, [{ metadata: { retryCount: 1 } }])
				.retryCount,
		).toBe(3);
	});
});

describe("recoverableDelegationWorkOrder", () => {
	it("prefers the canonical top-level work order", () => {
		expect(
			recoverableDelegationWorkOrder({
				delegationWorkOrder: { objective: "canonical" },
				homeDelegation: { workOrder: { objective: "legacy" } },
			}),
		).toEqual({ objective: "canonical" });
	});

	it("recovers older approval runs from homeDelegation.workOrder", () => {
		expect(
			recoverableDelegationWorkOrder({
				delegationWorkOrder: null,
				homeDelegation: {
					workOrder: {
						objective: "retry this",
						executionRequirement: { surface: "native" },
					},
				},
			}),
		).toEqual({
			objective: "retry this",
			executionRequirement: { surface: "native" },
		});
	});
});
