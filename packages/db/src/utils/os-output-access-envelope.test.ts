import { describe, expect, it } from "vite-plus/test";
import { mergeOsOutputAccessEnvelopes } from "./os-output-access-envelope";

const source = (overrides: Record<string, unknown> = {}) => ({
	workspaceResourceId: "11111111-1111-4111-8111-111111111111",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	providerId: "google-drive",
	resourceType: "document",
	providerResourceId: "doc-1",
	connectionScope: "tenant",
	requiredScopes: ["documents.read"],
	operations: ["read"],
	...overrides,
});
const envelope = (...sources: unknown[]) =>
	JSON.stringify({ version: 1, sources });

describe("output access envelope lineage", () => {
	it("preserves prior sources and unions producer capabilities", () => {
		const merged = mergeOsOutputAccessEnvelopes(
			envelope(source()),
			envelope(
				source({ requiredScopes: ["files.read"], operations: ["export"] }),
			),
		);
		expect(JSON.parse(merged!)).toEqual({
			version: 1,
			sources: [
				source({
					requiredScopes: ["documents.read", "files.read"],
					operations: ["export", "read"],
				}),
			],
		});
	});

	it("fails closed for absent, malformed, conflicting, or over-bound lineage", () => {
		expect(mergeOsOutputAccessEnvelopes(null, envelope())).toBeNull();
		expect(mergeOsOutputAccessEnvelopes("not-json", envelope())).toBeNull();
		expect(
			mergeOsOutputAccessEnvelopes(
				envelope(source()),
				envelope(source({ providerResourceId: "different" })),
			),
		).toBeNull();
		expect(
			mergeOsOutputAccessEnvelopes(
				envelope(
					...Array.from({ length: 25 }, (_, index) =>
						source({
							workspaceResourceId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
							providerResourceId: `doc-${index}`,
						}),
					),
				),
				envelope(
					source({
						workspaceResourceId: "aaaaaaaa-1111-4111-8111-111111111111",
						providerResourceId: "extra",
					}),
				),
			),
		).toBeNull();
	});
});
