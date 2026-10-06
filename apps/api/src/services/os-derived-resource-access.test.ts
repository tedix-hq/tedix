import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "./os-derived-resource-access";

const mocks = vi.hoisted(() => ({ resource: vi.fn(), availability: vi.fn() }));
vi.mock("@tedix/db/queries/os-workspaces/resources", () => ({
	getOsWorkspaceResource: mocks.resource,
}));
vi.mock("./os-workspace-resource-availability", () => ({
	resolveWorkspaceResourceAvailability: mocks.availability,
}));

const source = {
	workspaceResourceId: "11111111-1111-4111-8111-111111111111",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	providerId: "github",
	resourceType: "repository",
	providerResourceId: "tedix-hq/tedix",
	connectionScope: "tenant" as const,
	requiredScopes: ["repo:read"],
	operations: ["read"],
};
const envelope = { version: 1 as const, sources: [source] };
const context = {
	organizationId: "org-1",
	authType: "service",
	db: {},
} as unknown as BaseContext;

describe("derived output source authorization", () => {
	beforeEach(() => {
		mocks.resource.mockReset().mockResolvedValue({
			id: source.workspaceResourceId,
			organizationId: "org-1",
			workspaceId: source.workspaceId,
			providerId: source.providerId,
			resourceType: source.resourceType,
			providerResourceId: source.providerResourceId,
			connectionScope: "tenant",
			requiredScopes: '["repo:read","metadata:read"]',
			status: "active",
		});
		mocks.availability.mockReset().mockResolvedValue({ status: "available" });
	});

	it("preserves authenticated service and tedi callers for valid tenant sources", async () => {
		for (const authType of ["service", "tedi"] as const) {
			expect(
				await authorizeDerivedOutputSources(
					{ ...context, authType } as BaseContext,
					{ organizationId: "org-1", accessEnvelope: envelope },
				),
			).toBe(true);
		}
	});

	it("allows a valid source-free envelope but rejects missing or malformed envelopes", async () => {
		expect(
			await authorizeDerivedOutputSources(context, {
				organizationId: "org-1",
				accessEnvelope: { version: 1, sources: [] },
			}),
		).toBe(true);
		expect(parseDerivedAccessEnvelope(null)).toBeNull();
		expect(parseDerivedAccessEnvelope("not json")).toBeNull();
	});

	it.each([
		["wrong org", () => ({ organizationId: "org-2" })],
		["removed resource", () => ({ status: "removed" })],
		["resource identity drift", () => ({ providerResourceId: "other/repo" })],
		["scope loss", () => ({ requiredScopes: "[]" })],
	])("fails closed for %s", async (_label, drift) => {
		if (_label === "wrong org") {
			expect(
				await authorizeDerivedOutputSources(context, {
					organizationId: "org-2",
					accessEnvelope: envelope,
				}),
			).toBe(false);
			return;
		}
		mocks.resource.mockResolvedValue({
			...(await mocks.resource()),
			...drift(),
		});
		expect(
			await authorizeDerivedOutputSources(context, {
				organizationId: "org-1",
				accessEnvelope: envelope,
			}),
		).toBe(false);
	});

	it("fails closed when the governed connection becomes unavailable", async () => {
		mocks.availability.mockResolvedValue({ status: "missing_connection" });
		expect(
			await authorizeDerivedOutputSources(context, {
				organizationId: "org-1",
				accessEnvelope: envelope,
			}),
		).toBe(false);
	});

	it("revalidates every live required scope instead of only the historical envelope scopes", async () => {
		mocks.availability.mockImplementation(
			async (_context, resource: { requiredScopes: string[] }) => ({
				status: resource.requiredScopes.includes("metadata:read")
					? "missing_scope"
					: "available",
			}),
		);
		expect(
			await authorizeDerivedOutputSources(context, {
				organizationId: "org-1",
				accessEnvelope: envelope,
			}),
		).toBe(false);
		expect(mocks.availability).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				requiredScopes: ["repo:read", "metadata:read"],
			}),
		);
	});

	it.each(["null", '"repo:read"', '["repo:read",1]'])(
		"rejects non-string-array persisted scopes: %s",
		async (requiredScopes) => {
			mocks.resource.mockResolvedValue({
				...(await mocks.resource()),
				requiredScopes,
			});
			expect(
				await authorizeDerivedOutputSources(context, {
					organizationId: "org-1",
					accessEnvelope: envelope,
				}),
			).toBe(false);
		},
	);

	it("turns provider or database failures into a fail-closed decision", async () => {
		mocks.resource.mockRejectedValue(new Error("D1 unavailable"));
		expect(
			await authorizeDerivedOutputSources(context, {
				organizationId: "org-1",
				accessEnvelope: envelope,
			}),
		).toBe(false);
	});
});
