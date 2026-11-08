import { describe, expect, it } from "vite-plus/test";
import {
	MemoryOwnerScopeSchema,
	type MemoryOwnerScope,
} from "@tedix/api-contract/schemas/memory-graph";
import { authorizeMemoryOwner, memoryStoreName } from "./memory-owner";
import { tenantStoreName } from "./router";

const access = {
	organizationId: "fictional-org",
	principalId: "principal-a",
	workspaceIds: ["workspace-a"],
};
const organization: MemoryOwnerScope = {
	kind: "organization",
	organizationId: access.organizationId,
};

describe("memory ownership boundary", () => {
	it("allows organization memory independently of project workspace access", () => {
		expect(
			authorizeMemoryOwner(organization, { ...access, workspaceIds: [] }),
		).toEqual(organization);
		expect(
			authorizeMemoryOwner(organization, {
				...access,
				workspaceIds: ["workspace-b"],
			}),
		).toEqual(organization);
		expect(() =>
			authorizeMemoryOwner(organization, {
				...access,
				organizationId: "fictional-other",
			}),
		).toThrow("authenticated organization");
		expect(() =>
			authorizeMemoryOwner(organization, { ...access, principalId: "" }),
		).toThrow("authenticated organization");
	});

	it("requires explicit workspace access and the exact personal owner", () => {
		const workspace = {
			...organization,
			kind: "workspace",
			workspaceId: "workspace-a",
		} as const;
		const personal = {
			...organization,
			kind: "personal",
			principalId: access.principalId,
		} as const;
		expect(authorizeMemoryOwner(workspace, access)).toEqual(workspace);
		expect(() =>
			authorizeMemoryOwner(workspace, { ...access, workspaceIds: [] }),
		).toThrow("requires workspace access");
		expect(
			authorizeMemoryOwner(personal, { ...access, workspaceIds: [] }),
		).toEqual(personal);
		expect(() =>
			authorizeMemoryOwner(personal, { ...access, principalId: "principal-b" }),
		).toThrow("another principal");
	});

	it("uses disjoint encoded owner keys without rewriting opaque IDs", () => {
		const names = [
			memoryStoreName(organization),
			memoryStoreName({
				...organization,
				kind: "workspace",
				workspaceId: access.organizationId,
			}),
			memoryStoreName({
				...organization,
				kind: "personal",
				principalId: access.organizationId,
			}),
			tenantStoreName({
				organizationId: "memory:organization",
				workspaceId: access.organizationId,
			}),
		];
		expect(new Set(names).size).toBe(names.length);
		expect(
			memoryStoreName({
				kind: "personal",
				organizationId: "a:b",
				principalId: "c",
			}),
		).not.toBe(
			memoryStoreName({
				kind: "personal",
				organizationId: "a",
				principalId: "b:c",
			}),
		);
		expect(
			MemoryOwnerScopeSchema.parse({
				kind: "organization",
				organizationId: " org ",
			}).organizationId,
		).toBe(" org ");
	});

	it("rejects ambiguous ownership, missing owners and policy fields in routing inputs", () => {
		for (const owner of [
			{ ...organization, workspaceId: "workspace-a" },
			{ ...organization, kind: "personal" },
			{ ...organization, kind: "workspace", workspaceId: " " },
			{ ...organization, visibility: "org" },
			{ ...organization, usePolicy: "can_use_as_instruction" },
		])
			expect(MemoryOwnerScopeSchema.safeParse(owner).success).toBe(false);
	});
});
