import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	listWorkItemReadinessProjection: vi.fn(),
	deriveWorkItemReadiness: vi.fn(),
}));

vi.mock("@tedix/db/queries/work-items/readiness", () => mocks);

import { workItemsContractRouter } from "./work-items";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-08-20T12:00:00.000Z";
const OBSERVED_AT = "2026-08-21T12:00:00.000Z";

function context(organizationId: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/workItems"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: [],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function projectionPage() {
	return {
		data: [
			{
				workItem: {
					id: ITEM_ID,
					title: "Restore the Work queue",
					disposition: "accepted" as const,
					workKind: "operations" as const,
					riskLevel: "medium" as const,
					priority: "high" as const,
					projectId: PROJECT_ID,
					accountableOwnerType: "user" as const,
					accountableOwnerId: "user-1",
					createdAt: CREATED_AT,
					updatedAt: null,
				},
				readiness: {
					workItemId: ITEM_ID,
					state: "ready" as const,
					ready: true,
					reasons: [],
					derivedAt: OBSERVED_AT,
					gates: [],
				},
			},
		],
		nextCursor: { createdAt: CREATED_AT, id: ITEM_ID },
		hasMore: true,
		observedAt: OBSERVED_AT,
	};
}

beforeEach(() => {
	mocks.listWorkItemReadinessProjection.mockReset();
	mocks.deriveWorkItemReadiness.mockReset();
	mocks.listWorkItemReadinessProjection.mockResolvedValue(projectionPage());
});

describe("bounded Work queue readiness projection", () => {
	it("uses one DB projection call and never derives readiness per item", async () => {
		const client = createRouterClient(workItemsContractRouter, {
			context: context("org-1"),
		});
		const result = await client.listReadinessProjection({
			projectId: PROJECT_ID,
			workKind: "operations",
			cursor: { at: CREATED_AT, id: ITEM_ID },
			limit: 25,
		});

		expect(mocks.listWorkItemReadinessProjection).toHaveBeenCalledOnce();
		expect(mocks.listWorkItemReadinessProjection).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				orgId: "org-1",
				projectId: PROJECT_ID,
				workKind: "operations",
				cursor: { createdAt: CREATED_AT, id: ITEM_ID },
				limit: 25,
			}),
		);
		expect(mocks.deriveWorkItemReadiness).not.toHaveBeenCalled();
		expect(result.nextCursor).toEqual({ at: CREATED_AT, id: ITEM_ID });
		expect(result.data).toHaveLength(1);
	});

	it("binds every projection read to the authenticated organization", async () => {
		const org1 = createRouterClient(workItemsContractRouter, {
			context: context("org-1"),
		});
		const org2 = createRouterClient(workItemsContractRouter, {
			context: context("org-2"),
		});

		await org1.listReadinessProjection({ limit: 1 });
		await org2.listReadinessProjection({ limit: 1 });

		expect(mocks.listWorkItemReadinessProjection.mock.calls).toHaveLength(2);
		expect(
			mocks.listWorkItemReadinessProjection.mock.calls.map(
				([, params]) => params.orgId,
			),
		).toEqual(["org-1", "org-2"]);
	});
});
