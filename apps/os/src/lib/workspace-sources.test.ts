import { describe, expect, it } from "vite-plus/test";
import {
	sourceOrigin,
	sourceTarget,
	sourceTypeLabel,
	type WorkspaceSource,
} from "./workspace-sources";

const source = (patch: Partial<WorkspaceSource>): WorkspaceSource => ({
	id: "11111111-1111-4111-8111-111111111111",
	name: "Example source",
	providerId: "notion",
	resourceType: "page",
	providerResourceId: "page-1",
	connectionScope: "tenant",
	metadata: {},
	updatedAt: "2026-10-01T00:00:00.000Z",
	...patch,
});

describe("workspace sources", () => {
	it("names the type in one plain word", () => {
		expect(sourceTypeLabel("research_account")).toBe("Account");
		expect(sourceTypeLabel("spreadsheet")).toBe("Spreadsheet");
		expect(sourceTypeLabel("page")).toBe("Page");
		expect(sourceTypeLabel("output")).toBe("Output");
	});

	it("says whose account a source uses", () => {
		expect(sourceOrigin(source({}), "Notion")).toBe(
			"Notion · shared organization account",
		);
		expect(sourceOrigin(source({ connectionScope: "user" }), "Notion")).toBe(
			"Notion · your own account",
		);
		expect(sourceOrigin(source({ providerId: "tedix" }), "Tedix")).toBe(
			"Tedix · made in this organization",
		);
	});

	it("opens a Tedix output in the workspace", () => {
		expect(
			sourceTarget(
				source({
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: "out-1",
				}),
			),
		).toEqual({ kind: "output", outputId: "out-1" });
		expect(
			sourceTarget(source({ providerId: "tedix", resourceType: "tedi" })),
		).toBeNull();
		expect(
			sourceTarget(source({ providerId: "tedix", resourceType: "file" })),
		).toEqual({ kind: "file" });
	});

	it("opens a stored web address before any derived one", () => {
		expect(
			sourceTarget(source({ metadata: { url: "https://example.com/page" } })),
		).toEqual({
			kind: "link",
			href: "https://example.com/page",
			external: true,
		});
		expect(
			sourceTarget(source({ metadata: { url: "javascript:alert(1)" } })),
		).toEqual({ kind: "link", href: "/admin/connections", external: false });
	});

	it("derives provider pages from their ids", () => {
		expect(
			sourceTarget(
				source({ providerResourceId: "0f8fad5b-d9cb-469f-a165-70867728950e" }),
			),
		).toMatchObject({
			href: "https://www.notion.so/0f8fad5bd9cb469fa16570867728950e",
		});
		expect(
			sourceTarget(
				source({
					providerId: "google_sheets",
					resourceType: "spreadsheet",
					providerResourceId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
				}),
			),
		).toMatchObject({
			href: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz",
		});
		expect(
			sourceTarget(
				source({
					providerId: "github",
					resourceType: "repository",
					providerResourceId: "example/repo",
				}),
			),
		).toMatchObject({ href: "https://github.com/example/repo" });
	});

	it("opens an account on the matching Connections page", () => {
		expect(
			sourceTarget(
				source({ providerId: "firecrawl", resourceType: "research_account" }),
			),
		).toEqual({ kind: "link", href: "/admin/connections", external: false });
		expect(
			sourceTarget(
				source({
					providerId: "firecrawl",
					resourceType: "research_account",
					connectionScope: "user",
				}),
			),
		).toEqual({ kind: "link", href: "/account/connections", external: false });
	});
});
