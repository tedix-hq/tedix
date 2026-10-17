import { describe, expect, it } from "vite-plus/test";
import {
	ListAgentSessionActivityInputSchema,
	ListAgentSessionActivityResultSchema,
} from "./agent-session-requests";

describe("session activity contract", () => {
	it("does not accept an owner, tenant or arbitrary grant supplied by a tedi", () => {
		const input = { since: "2026-10-01T00:00:00Z" };
		expect(ListAgentSessionActivityInputSchema.parse(input).limit).toBe(50);
		for (const field of ["userId", "organizationId", "delegationId"]) {
			expect(
				ListAgentSessionActivityInputSchema.safeParse({
					...input,
					[field]: "another-owner",
				}).success,
			).toBe(false);
		}
		expect(
			ListAgentSessionActivityInputSchema.safeParse({ ...input, limit: 101 })
				.success,
		).toBe(false);
	});
	it("represents an explicit grant wait with no source bytes", () => {
		expect(
			ListAgentSessionActivityResultSchema.parse({
				status: "needs_grant",
				summary: "waiting for the owner's grant",
				data: [],
			}).status,
		).toBe("needs_grant");
	});
});
