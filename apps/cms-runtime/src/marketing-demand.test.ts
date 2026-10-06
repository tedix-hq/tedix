import { describe, expect, it } from "vite-plus/test";
import {
	demandSourceIntentId,
	demandWorkItemTitle,
	isSyntheticDemand,
	parseDemandIntake,
} from "./marketing-demand";

describe("demand intake", () => {
	it("requires buyer context and consent", () => {
		expect(parseDemandIntake({ email: "buyer@example.com" })).toEqual({
			ok: false,
			error:
				"Describe the process, its current owner, and the systems involved.",
		});
		expect(
			parseDemandIntake({
				email: "buyer@example.com",
				process: "Reconcile weekly supplier exceptions",
				currentOwner: "Operations lead",
				systems: "Email, ERP",
				consent: false,
			}),
		).toEqual({
			ok: false,
			error: "Confirm that Tedix may contact you about this process.",
		});
	});

	it("normalizes bounded fields and preserves attribution", () => {
		expect(
			parseDemandIntake({
				email: " BUYER@EXAMPLE.COM ",
				process: " Reconcile weekly supplier exceptions ",
				currentOwner: " Operations lead ",
				systems: " Email, ERP ",
				consent: true,
				website: "",
				utmSource: "linkedin",
				utmCampaign: "durable-workers",
			}),
		).toEqual({
			ok: true,
			data: {
				email: "buyer@example.com",
				process: "Reconcile weekly supplier exceptions",
				currentOwner: "Operations lead",
				systems: "Email, ERP",
				consent: true,
				website: "",
				utmSource: "linkedin",
				utmCampaign: "durable-workers",
			},
		});
	});

	it("uses stable idempotency without exposing the email", async () => {
		const first = await demandSourceIntentId(
			"Buyer@Example.com",
			"Reconcile weekly supplier exceptions",
		);
		const replay = await demandSourceIntentId(
			" buyer@example.com ",
			" reconcile weekly supplier exceptions ",
		);
		expect(first).toBe(replay);
		expect(first).toMatch(/^landing-demand:[a-f0-9]{64}$/);
		expect(first).not.toContain("buyer");
	});

	it("keeps board titles verb-first and marks reserved validation traffic", () => {
		expect(demandWorkItemTitle("  Reconcile\nweekly invoices ")).toBe(
			"Qualify recurring process: Reconcile weekly invoices",
		);
		expect(isSyntheticDemand("codex@example.invalid")).toBe(true);
		expect(isSyntheticDemand("buyer@example.com")).toBe(false);
	});
});
