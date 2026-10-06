import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	prepareWorkspaceRepositoryWork,
	WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT,
} from "./os-workspace-repository-work";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TEDI_ID = "44444444-4444-4444-8444-444444444444";
const WORK_ITEM_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666";
const UPDATED_AT = "2026-10-01T12:00:00.000Z";

function fixture() {
	const context = {
		authType: "user",
		db: {},
		env: { DB: {} },
		organizationId: "org-1",
		user: { sub: "user-1" },
	} as unknown as BaseContext;
	const input = {
		workspaceId: WORKSPACE_ID,
		resourceId: RESOURCE_ID,
		expectedUpdatedAt: UPDATED_AT,
		projectId: PROJECT_ID,
		tediId: TEDI_ID,
		task: "Port the guarded repository change",
		outcome: "The change is committed with focused tests passing.",
		idempotencyKey: IDEMPOTENCY_KEY,
	};
	const workspace = {
		id: WORKSPACE_ID,
		organizationId: "org-1",
		status: "active",
	} as never;
	const resourceRow = {
		id: RESOURCE_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		status: "active",
		updatedAt: UPDATED_AT,
	} as never;
	const resource = {
		id: RESOURCE_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		slot: null,
		providerId: "github",
		connectionScope: "tenant",
		requiredScopes: ["contents:write"],
		resourceType: "repository",
		providerResourceId: "12345",
		name: "Tedix",
		metadata: {
			githubFullName: "tedix-hq/tedix",
			githubInstallationId: 98765,
		},
		status: "active",
		createdByKind: "user",
		createdById: "user-1",
		createdAt: UPDATED_AT,
		updatedAt: UPDATED_AT,
		removedAt: null,
	} as const;
	const dependencies = {
		availability: vi.fn().mockResolvedValue({
			status: "available",
			reason: null,
			checkedAt: UPDATED_AT,
		}),
		getTedi: vi.fn().mockResolvedValue({
			id: TEDI_ID,
			organizationId: "org-1",
			status: "active",
			retiredAt: null,
			repoConfig: {
				repoUrl: "https://github.com/tedix-hq/tedix",
				githubRepositoryId: 12345,
				githubInstallationId: 98765,
				githubAppEnabled: true,
			},
		}),
		getProjectLink: vi.fn().mockResolvedValue({ status: "active" }),
		getProject: vi.fn().mockResolvedValue({
			id: PROJECT_ID,
			orgId: "org-1",
			status: "active",
			objectiveId: null,
		}),
		getWorkItem: vi.fn().mockResolvedValue(null),
		createWorkItem: vi.fn(),
		acceptWorkItem: vi.fn(),
	};
	return { context, input, workspace, resourceRow, resource, dependencies };
}

describe("prepareWorkspaceRepositoryWork", () => {
	it("fails closed when the canonical connection was revoked", async () => {
		const value = fixture();
		value.dependencies.availability.mockResolvedValue({
			status: "missing_connection",
			reason: "Reconnect this app before using the Workspace resource.",
			checkedAt: UPDATED_AT,
		});
		await expect(
			prepareWorkspaceRepositoryWork(
				value.context,
				value,
				value.dependencies as never,
			),
		).rejects.toThrow("Reconnect this app");
		expect(value.dependencies.createWorkItem).not.toHaveBeenCalled();
	});

	it("rejects a tedi configured for a different immutable repository", async () => {
		const value = fixture();
		value.dependencies.getTedi.mockResolvedValue({
			id: TEDI_ID,
			organizationId: "org-1",
			status: "active",
			retiredAt: null,
			repoConfig: {
				repoUrl: "https://github.com/tedix-hq/tedix",
				githubRepositoryId: 99999,
				githubInstallationId: 98765,
				githubAppEnabled: true,
			},
		});
		await expect(
			prepareWorkspaceRepositoryWork(
				value.context,
				value,
				value.dependencies as never,
			),
		).rejects.toThrow("does not exactly match");
	});

	it("does not resolve a cross-tenant tedi", async () => {
		const value = fixture();
		value.dependencies.getTedi.mockResolvedValue(undefined);
		await expect(
			prepareWorkspaceRepositoryWork(
				value.context,
				value,
				value.dependencies as never,
			),
		).rejects.toThrow("Eligible tedi not found");
		expect(value.dependencies.getTedi).toHaveBeenCalledWith(
			value.context.db,
			TEDI_ID,
			"org-1",
		);
	});

	it("rejects a stale Workspace resource before checking authority", async () => {
		const value = fixture();
		value.input.expectedUpdatedAt = "2026-09-30T12:00:00.000Z";
		await expect(
			prepareWorkspaceRepositoryWork(
				value.context,
				value,
				value.dependencies as never,
			),
		).rejects.toThrow("resource changed");
		expect(value.dependencies.availability).not.toHaveBeenCalled();
	});

	it("accepts one canonical Work Item and returns a secret-free kernel dispatch", async () => {
		const value = fixture();
		let proposed: Record<string, unknown> | null = null;
		value.dependencies.createWorkItem.mockImplementation(
			async (_db: unknown, item: Record<string, unknown>) => {
				proposed = item;
				return { ...item, disposition: "proposed", acceptanceContract: null };
			},
		);
		value.dependencies.acceptWorkItem.mockImplementation(
			async (_db: unknown, request: { acceptanceContract: unknown }) => ({
				...proposed,
				id: WORK_ITEM_ID,
				disposition: "accepted",
				acceptanceContract: request.acceptanceContract,
			}),
		);

		const result = await prepareWorkspaceRepositoryWork(
			value.context,
			value,
			value.dependencies as never,
		);

		expect(result).toMatchObject({
			workItemId: WORK_ITEM_ID,
			dispatch: {
				delegateToTediId: TEDI_ID,
				metadata: {
					workItemId: WORK_ITEM_ID,
					needsEmbodiedSurface: true,
					executionRequirement: WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT,
				},
			},
		});
		expect(proposed).toMatchObject({
			projectId: PROJECT_ID,
			accountableOwnerId: TEDI_ID,
			provenance: {
				githubRepositoryId: 12345,
				githubFullName: "tedix-hq/tedix",
				githubInstallationId: 98765,
			},
		});
		expect(JSON.stringify(proposed)).not.toMatch(
			/token|secret|password|credential/i,
		);
	});
});
