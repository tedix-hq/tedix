import { describe, expect, it } from "vite-plus/test";
import {
	OsWorkspaceResourceSchema,
	OsWorkspaceResourceSelectionSchema,
} from "../schemas/os-workspaces";

const selection = {
	providerId: "github",
	connectionScope: "tenant" as const,
	requiredScopes: ["contents:read"],
	resourceType: "repository",
	providerResourceId: "tedix-hq/tedix",
	name: "Product repository",
	metadata: { url: "https://github.com/tedix-hq/tedix" },
};

describe("Workspace resource contracts", () => {
	it("represents one concrete provider object without credential material", () => {
		expect(OsWorkspaceResourceSelectionSchema.parse(selection)).toEqual(
			selection,
		);
		expect(
			OsWorkspaceResourceSchema.parse({
				id: "00000000-0000-4000-8000-000000000001",
				organizationId: "org-1",
				workspaceId: "00000000-0000-4000-8000-000000000002",
				slot: null,
				...selection,
				status: "active",
				createdByKind: "user",
				createdById: "user-1",
				createdAt: "2026-08-20T00:00:00.000Z",
				updatedAt: "2026-08-20T00:00:00.000Z",
				removedAt: null,
			}),
		).toMatchObject(selection);
	});

	it("requires a canonical named account for personal selection and rejects injected owner identity", () => {
		expect(
			OsWorkspaceResourceSelectionSchema.safeParse({
				...selection,
				connectionScope: "user",
			}).success,
		).toBe(false);
		const personal = {
			...selection,
			connectionScope: "user",
			connectionInstanceId: "00000000-0000-4000-8000-000000000003",
		};
		expect(OsWorkspaceResourceSelectionSchema.parse(personal)).toEqual(
			personal,
		);
		expect(
			OsWorkspaceResourceSelectionSchema.safeParse({
				...personal,
				personalOwnerUserId: "other",
			}).success,
		).toBe(false);
	});

	it.each([
		"accessToken",
		"client_secret",
		"password",
		"api-key",
		"credential",
	])("rejects credential-like metadata key %s", (key) => {
		expect(
			OsWorkspaceResourceSelectionSchema.safeParse({
				...selection,
				metadata: { [key]: "must-not-persist" },
			}).success,
		).toBe(false);
	});

	it("rejects unresolved connection scope and unknown top-level fields", () => {
		expect(
			OsWorkspaceResourceSelectionSchema.safeParse({
				...selection,
				connectionScope: "either",
			}).success,
		).toBe(false);
		expect(
			OsWorkspaceResourceSelectionSchema.safeParse({
				...selection,
				accessToken: "must-not-persist",
			}).success,
		).toBe(false);
	});
});
