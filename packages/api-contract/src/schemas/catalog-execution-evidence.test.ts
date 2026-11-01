import { describe, expect, it } from "vite-plus/test";
import { CatalogAppDetailSchema } from "./catalog";
import { buildCompletionEvidence } from "./execution-evidence";

// Nullable listing fields are deliberately absent metadata, not scan proof.
const listing = {
	...Object.fromEntries(
		Object.entries(CatalogAppDetailSchema.shape)
			.filter(([, schema]) => schema.safeParse(null).success)
			.map(([key]) => [key, null]),
	),
	id: "11111111-1111-4111-8111-111111111111",
	slug: "example-docs",
	name: "Example Docs",
	status: "ENABLED",
	healthStatus: "requires_auth",
	discoverability: { score: 0, label: "Low", criteria: [], tips: [] },
	quality: {
		score: 0,
		label: "Thin",
		status: "thin",
		logoStatus: "missing",
		sourceConfidence: "low",
		freshnessStatus: "unknown",
		signals: [],
	},
	installability: {
		installable: false,
		state: "listing_only",
		reason: "Metadata only",
	},
};

function evidence(result: unknown, operation = "get_catalog_app") {
	return buildCompletionEvidence({ operation, result, retryKey: "listing" });
}

describe("catalog lookup completion", () => {
	it.each(["ENABLED", "DISABLED"])(
		"reads a %s listing without claiming its server was verified",
		(status) => {
			const result = { ...listing, status };
			expect(CatalogAppDetailSchema.safeParse(result).success).toBe(true);
			expect(evidence(result)).toMatchObject({
				status: "succeeded",
				supportedClaims: ["get_catalog_app returned successfully"],
				providerConfirmation: "unknown",
				retry: { retryable: false },
			});
			expect(result.healthStatus).toBe("requires_auth");
		},
	);

	it.each([
		[{ success: false }, "failed"],
		[{ error: "Provider failure" }, "failed"],
		[{ partial: true }, "partial"],
		[{ running: true }, "pending"],
		[{ state: "denied" }, "failed"],
		[{ canceled: true }, "canceled"],
	])("preserves operation flags %j", (flags, expected) => {
		expect(evidence({ ...listing, ...flags }).status).toBe(expected);
	});

	it.each([
		{ id: listing.id, status: "ENABLED" },
		{ ...listing, name: undefined },
		{ ...listing, discoverability: {} },
		{ ...listing, status: "waiting_for_vendor" },
	])("does not certify malformed or unknown listing states", (result) => {
		expect(evidence(result).status).toBe("partial");
	});

	it.each([
		"update_catalog_app",
		"provider_operation",
		"catalog.get_catalog_app",
	])("does not broaden other operation %s", (operation) => {
		expect(evidence(listing, operation).status).toBe("partial");
	});
});
