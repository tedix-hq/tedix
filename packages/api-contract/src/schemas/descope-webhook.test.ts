import { describe, expect, it } from "vite-plus/test";
import { DescopeAuditBatchSchema } from "./descope-webhook";
const event = { action: "UserModified", occurred: 1780949905871 };
describe("Descope webhook wire contract", () => {
	it("accepts documented optional context and open nested event data", () => {
		const payload = [
			{
				...event,
				projectId: "project",
				occurred_formatted: "2026-06-08T20:18:25.871835Z",
				tenants: null,
				data: { Change: { custom_attribute_lastPasswordReset: 1780949905852 } },
			},
		];
		expect(DescopeAuditBatchSchema.parse(payload)).toEqual(payload);
		expect(DescopeAuditBatchSchema.parse([event])).toEqual([event]);
	});
	it("accepts empty through 100-event arrays but rejects other envelopes", () => {
		expect(DescopeAuditBatchSchema.parse([])).toEqual([]);
		expect(DescopeAuditBatchSchema.parse(Array(100).fill(event))).toHaveLength(
			100,
		);
		for (const payload of [
			Array(101).fill(event),
			event,
			{ events: [event] },
			null,
		])
			expect(DescopeAuditBatchSchema.safeParse(payload).success).toBe(false);
	});
	it("requires usable numeric millisecond timestamps without coercion", () => {
		for (const occurred of [
			"1780949905871",
			"2026-06-08T20:18:25Z",
			null,
			NaN,
			Infinity,
			8640000000000001,
			-8640000000000001,
		])
			expect(
				DescopeAuditBatchSchema.safeParse([{ ...event, occurred }]).success,
			).toBe(false);
		for (const occurred of [1000, -1, 0.5, 1780949905871.5]) {
			expect(
				DescopeAuditBatchSchema.parse([{ ...event, occurred }])[0]!.occurred,
			).toBe(occurred);
		}
	});
	it("rejects malformed tenant context", () => {
		for (const tenants of ["tenant", [null], [1]])
			expect(
				DescopeAuditBatchSchema.safeParse([{ ...event, tenants }]).success,
			).toBe(false);
	});
});
