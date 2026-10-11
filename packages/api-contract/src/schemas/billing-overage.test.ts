import { describe, expect, test } from "vite-plus/test";
import {
	BILLING_OVERAGE_MONTHLY_CAP_MAX_MICROS,
	SetBillingOverageSettingsInputSchema,
} from "./billing";

describe("SetBillingOverageSettingsInputSchema", () => {
	test("requires a positive cap while enabled", () => {
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: true,
				monthlyCapMicros: null,
			}).success,
		).toBe(false);
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: true,
				monthlyCapMicros: 0,
			}).success,
		).toBe(false);
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: true,
				monthlyCapMicros: 50_000_000,
			}).success,
		).toBe(true);
	});

	test("caps the cap and rejects fractional micros", () => {
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: true,
				monthlyCapMicros: BILLING_OVERAGE_MONTHLY_CAP_MAX_MICROS + 1,
			}).success,
		).toBe(false);
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: true,
				monthlyCapMicros: 1.5,
			}).success,
		).toBe(false);
	});

	test("lets an admin disable overage without a cap", () => {
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({
				enabled: false,
				monthlyCapMicros: null,
			}).success,
		).toBe(true);
		expect(
			SetBillingOverageSettingsInputSchema.safeParse({ enabled: false })
				.success,
		).toBe(false);
	});
});
