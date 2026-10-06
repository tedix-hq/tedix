import { describe, expect, it, vi } from "vite-plus/test";
import type { TediArtifactRow } from "@tedix/db/queries/cognitive-runtime";
import type { BaseContext } from "../rpc/orpc";
import {
	authorizeAuthenticatedArtifactBytes,
	authorizePublicArtifactBytes,
} from "./artifact-access";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../services/os-derived-resource-access", () => ({
	authorizeDerivedOutputSources: mocks.authorize,
}));

const base = {
	id: "artifact-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	accessClassification: "source_derived",
	contentDigest: "a".repeat(64),
	producerExecutionId: "execution-1",
	accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
	publicationState: "ready",
} as unknown as TediArtifactRow;

describe("artifact byte access", () => {
	it("preserves explicit legacy behavior", () => {
		expect(
			authorizePublicArtifactBytes({
				...base,
				accessClassification: null,
			}),
		).toEqual({ allowed: true });
	});

	it("fails closed for incomplete source-derived provenance", () => {
		for (const artifact of [
			{ ...base, contentDigest: null },
			{ ...base, producerExecutionId: null },
			{ ...base, accessEnvelope: null },
		]) {
			expect(authorizePublicArtifactBytes(artifact)).toEqual({
				allowed: false,
				reason: "missing_provenance",
			});
		}
	});

	it("denies every classified artifact until publication is ready", async () => {
		for (const artifact of [
			{ ...base, publicationState: "pending" as const },
			{
				...base,
				accessClassification: "explicit_shareable" as const,
				publicationState: "pending" as const,
			},
		]) {
			expect(authorizePublicArtifactBytes(artifact)).toEqual({
				allowed: false,
				reason: "missing_provenance",
			});
			await expect(
				authorizeAuthenticatedArtifactBytes(
					{ organizationId: "org-1" } as BaseContext,
					artifact,
				),
			).resolves.toEqual({
				allowed: false,
				reason: "missing_provenance",
			});
		}
		expect(mocks.authorize).not.toHaveBeenCalled();
	});

	it("fails closed for an unknown persisted classification", async () => {
		const artifact = {
			...base,
			accessClassification: "future_classification",
		} as unknown as TediArtifactRow;
		expect(authorizePublicArtifactBytes(artifact)).toEqual({
			allowed: false,
			reason: "missing_provenance",
		});
		await expect(
			authorizeAuthenticatedArtifactBytes(
				{ organizationId: "org-1" } as BaseContext,
				artifact,
			),
		).resolves.toEqual({
			allowed: false,
			reason: "missing_provenance",
		});
	});

	it("never converts a runtime-private artifact into a bearer capability", async () => {
		const artifact = {
			...base,
			accessClassification: "runtime_private" as const,
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		};
		expect(authorizePublicArtifactBytes(artifact)).toEqual({
			allowed: false,
			reason: "source_access_required",
		});
		await expect(
			authorizeAuthenticatedArtifactBytes(
				{ organizationId: "org-1" } as BaseContext,
				artifact,
			),
		).resolves.toEqual({
			allowed: false,
			reason: "source_access_required",
		});
		expect(mocks.authorize).not.toHaveBeenCalled();
	});

	it("allows public bytes only for a valid empty derived envelope", async () => {
		expect(authorizePublicArtifactBytes(base)).toEqual({ allowed: true });
		const protectedArtifact = {
			...base,
			accessEnvelope: JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: crypto.randomUUID(),
						workspaceId: crypto.randomUUID(),
						providerId: "github",
						resourceType: "repository",
						providerResourceId: "tedix-hq/tedix",
						connectionScope: "tenant",
						requiredScopes: ["repo:read"],
						operations: ["read"],
					},
				],
			}),
		};
		expect(authorizePublicArtifactBytes(protectedArtifact)).toEqual({
			allowed: false,
			reason: "source_access_required",
		});
		mocks.authorize.mockResolvedValueOnce(true);
		await expect(
			authorizeAuthenticatedArtifactBytes(
				{ organizationId: "org-1" } as BaseContext,
				protectedArtifact,
			),
		).resolves.toEqual({ allowed: true });
	});
});
