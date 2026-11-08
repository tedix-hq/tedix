import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { InternalEntrypoint } from "../src/index";
import type { WorkspaceEnv } from "../src/env";

describe("memory through the runtime service entrypoint", () => {
	test("serves organization memory without requiring a project workspace", async () => {
		const runtime = new InternalEntrypoint(
			createExecutionContext(),
			env as unknown as WorkspaceEnv,
		);
		const owner = {
			kind: "organization",
			organizationId: "fictional-service-memory",
		} as const;
		const access = {
			organizationId: owner.organizationId,
			principalId: "principal-a",
			workspaceIds: [],
		};
		await runtime.ownedMemory(owner, access, {
			operation: "createFact",
			input: {
				id: "org-fact",
				content: "Cobalt migration preserves policy",
				factType: "technical",
				visibility: "org",
				memoryScope: "tedi",
				usePolicy: "can_use_as_evidence",
				reviewStatus: "confirmed",
				tediId: "tedi-a",
			},
		});
		expect(
			await runtime.ownedMemory(
				owner,
				{ ...access, principalId: "principal-b" },
				{
					operation: "getFact",
					input: { factId: "org-fact" },
				},
			),
		).toMatchObject({
			content: "Cobalt migration preserves policy",
			tediId: "tedi-a",
			memoryScope: "tedi",
			usePolicy: "can_use_as_evidence",
		});
	});

	test("denies foreign organization, workspace and personal owners before touching the namespace", async () => {
		const runtime = new InternalEntrypoint(
			createExecutionContext(),
			{} as WorkspaceEnv,
		);
		const access = {
			organizationId: "fictional-org",
			principalId: "principal-a",
			workspaceIds: [],
		};
		const query = {
			operation: "getFact",
			input: { factId: "private-fact" },
		} as const;
		await expect(
			runtime.ownedMemory(
				{ kind: "organization", organizationId: "fictional-other" },
				access,
				query,
			),
		).rejects.toThrow("authenticated organization");
		await expect(
			runtime.ownedMemory(
				{
					kind: "workspace",
					organizationId: access.organizationId,
					workspaceId: "workspace-a",
				},
				access,
				query,
			),
		).rejects.toThrow("requires workspace access");
		await expect(
			runtime.ownedMemory(
				{
					kind: "personal",
					organizationId: access.organizationId,
					principalId: "principal-b",
				},
				access,
				query,
			),
		).rejects.toThrow("another principal");
	});
});
