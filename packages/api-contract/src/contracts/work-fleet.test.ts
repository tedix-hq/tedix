import { describe, expect, it } from "vite-plus/test";
import { WorkFleetControlTowerSchema } from "../schemas/work-fleet";
import { workFleetContract } from "./work-fleet";

describe("Work fleet contract", () => {
	it("exposes one derived control-tower read", () => {
		expect(Object.keys(workFleetContract)).toEqual(["getControlTower"]);
	});

	it("rejects negative aggregate counts", () => {
		expect(() =>
			WorkFleetControlTowerSchema.parse({
				observedAt: "2026-08-20T12:00:00.000Z",
				workItems: { total: -1, byDisposition: {} },
			}),
		).toThrow();
	});

	it("rejects mutable or unbounded attention actions", () => {
		const action = {
			key: "approval_backlog" as const,
			severity: "medium" as const,
			count: 1,
			label: "Decide pending approvals",
			rationale: "Pending authority decisions block admission.",
			href: "/work/approvals" as const,
		};
		expect(() =>
			WorkFleetControlTowerSchema.shape.attention.shape.actions.parse(
				Array.from({ length: 10 }, () => action),
			),
		).toThrow();
		expect(() =>
			WorkFleetControlTowerSchema.shape.attention.shape.actions.element.parse({
				...action,
				status: "done",
			}),
		).toThrow();
	});
});
