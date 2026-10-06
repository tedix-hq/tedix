import { describe, expect, it, vi } from "vite-plus/test";
import { runFencedGraphProjectionWrite } from "./graph-projection-batch-execution";

describe("fenced graph projection write", () => {
	it("renews the lease immediately before projecting", async () => {
		const order: string[] = [];
		const result = await runFencedGraphProjectionWrite({
			renewLease: async () => {
				order.push("renew");
				return true;
			},
			project: async () => {
				order.push("project");
			},
		});

		expect(order).toEqual(["renew", "project"]);
		expect(result).toEqual({ status: "projected" });
	});

	it("classifies a missing lease as coordination failure and skips Neo4j", async () => {
		const project = vi.fn(async () => undefined);
		const result = await runFencedGraphProjectionWrite({
			renewLease: async () => false,
			project,
		});

		expect(result).toEqual({ status: "lease_lost" });
		expect(project).not.toHaveBeenCalled();
	});

	it("lets lease-storage errors escape instead of classifying them as projection failures", async () => {
		const leaseError = new Error("D1 lease renewal unavailable");
		const project = vi.fn(async () => undefined);

		await expect(
			runFencedGraphProjectionWrite({
				renewLease: async () => {
					throw leaseError;
				},
				project,
			}),
		).rejects.toThrow(leaseError);
		expect(project).not.toHaveBeenCalled();
	});

	it("classifies only a Neo4j writer error as a projection failure", async () => {
		const result = await runFencedGraphProjectionWrite({
			renewLease: async () => true,
			project: async () => {
				throw new Error("Neo4j transaction failed");
			},
		});

		expect(result).toEqual({
			status: "projection_failed",
			error: "Neo4j transaction failed",
		});
	});
});
