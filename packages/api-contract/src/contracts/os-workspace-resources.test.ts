import { describe, expect, it } from "vite-plus/test";
import { procedureInputSchema } from "../utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "../utils/tool-json-schema";
import { osWorkspacesContract } from "./os-workspaces";
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
	it("accepts optional create slots and explicit slot-only edits in the tool schema", () => {
		const workspaceId = "00000000-0000-4000-8000-000000000002";
		const create = procedureInputSchema(osWorkspacesContract.resources.create);
		const update = procedureInputSchema(osWorkspacesContract.resources.rename);
		const input = {
			workspaceId,
			resourceId: workspaceId,
			expectedUpdatedAt: "observed",
		};
		expect(
			create.parse({ workspaceId, selection, slot: "opportunities" }),
		).toMatchObject({ slot: "opportunities" });
		expect(create.safeParse({ workspaceId, selection }).success).toBe(true);
		expect(update.parse({ ...input, slot: null })).toMatchObject({
			slot: null,
		});
		expect(update.parse({ ...input, slot: "opportunities" })).toMatchObject({
			slot: "opportunities",
		});
		expect(update.safeParse(input).success).toBe(false);
		for (const slot of [
			"",
			"Opportunities",
			"my-slot",
			"1slot",
			"a".repeat(121),
		]) {
			expect(create.safeParse({ workspaceId, selection, slot }).success).toBe(
				false,
			);
			expect(update.safeParse({ ...input, slot }).success).toBe(false);
		}
		for (const procedure of [
			osWorkspacesContract.resources.create,
			osWorkspacesContract.resources.rename,
		]) {
			const projected = zodToToolInputJsonSchema(
				procedureInputSchema(procedure),
			);
			expect(projected.properties).toHaveProperty("slot");
		}
	});

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
