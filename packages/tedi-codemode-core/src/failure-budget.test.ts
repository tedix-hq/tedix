import { describe, expect, it } from "vite-plus/test";
import {
	buildIdenticalCallKey,
	IdenticalFailureBudget,
} from "./failure-budget";

describe("IdenticalFailureBudget", () => {
	it("builds stable keys without exposing arguments", () => {
		const left = buildIdenticalCallKey("deploy", {
			secret: "do-not-leak",
			target: "prod",
		});
		const right = buildIdenticalCallKey("deploy", {
			target: "prod",
			secret: "do-not-leak",
		});

		expect(left).toBe(right);
		expect(left).not.toContain("do-not-leak");
	});

	it("blocks only after the configured number of identical failures", () => {
		const budget = new IdenticalFailureBudget(2);
		expect(budget.state("same")).toEqual({
			attempts: 0,
			blocked: false,
			limit: 2,
		});
		expect(budget.recordFailure("same").blocked).toBe(false);
		expect(budget.recordFailure("same")).toEqual({
			attempts: 2,
			blocked: true,
			limit: 2,
		});
		expect(budget.state("different").blocked).toBe(false);
	});

	it("clears a failure history after success", () => {
		const budget = new IdenticalFailureBudget();
		budget.recordFailure("same");
		expect(budget.recordSuccess("same").attempts).toBe(0);
	});
});
