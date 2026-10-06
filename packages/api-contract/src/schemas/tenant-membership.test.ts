import { describe, expect, it } from "vite-plus/test";
import {
	RemoveTenantMembershipResponseSchema,
	TenantMembershipUserRefSchema,
} from "./tenant-membership";

describe("tenant membership wire schemas", () => {
	it("requires a concrete Descope user reference", () => {
		expect(TenantMembershipUserRefSchema.safeParse({}).success).toBe(false);
		expect(
			TenantMembershipUserRefSchema.safeParse({ userId: "user-1" }).success,
		).toBe(true);
		expect(
			TenantMembershipUserRefSchema.safeParse({ loginId: "owner@example.com" })
				.success,
		).toBe(true);
	});

	it("requires the login ID proven by a successful removal", () => {
		const response = {
			userId: "user-1",
			loginId: null,
			descopeTenantId: "org-1",
			removedFromDescope: true,
			removedD1Row: false,
			remainingTenantCount: 0,
		};
		expect(
			RemoveTenantMembershipResponseSchema.safeParse(response).success,
		).toBe(false);
		expect(
			RemoveTenantMembershipResponseSchema.safeParse({
				...response,
				loginId: "owner@example.com",
			}).success,
		).toBe(true);
	});
});
