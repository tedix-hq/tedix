import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userContext, apiKeyContext } from "../test-context";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	canonicalMember: vi.fn(),
	organization: vi.fn(),
	upload: vi.fn(),
	request: vi.fn(),
	getImage: vi.fn(),
	remove: vi.fn(),
	getUrl: vi.fn(),
	updateUrl: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
	getMemberByCanonicalUserId: mocks.canonicalMember,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/entity-images", () => ({
	getEntityImageUrl: mocks.getUrl,
	updateEntityImageUrl: mocks.updateUrl,
	listLegacyEntityImagesForPlatform: vi.fn(),
	updateEntityImageUrlForPlatform: vi.fn(),
}));
vi.mock("../../lib/cf-images", async (load) => ({
	...(await load<typeof import("../../lib/cf-images")>()),
	uploadImageBytes: mocks.upload,
	requestDirectUpload: mocks.request,
	getCfImage: mocks.getImage,
	deleteCfImage: mocks.remove,
}));
import { imagesContractRouter } from "./images";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const target = { entityType: "organization" as const, entityId: orgB };
const upload = {
	...target,
	fileData: btoa("image bytes"),
	contentType: "image/png" as const,
	filename: "logo.png",
};
const client = (context = userContext({ organizationId: orgA })) =>
	createRouterClient(imagesContractRouter, { context });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ role: "owner", status: "active" });
	mocks.canonicalMember.mockResolvedValue({ role: "owner", status: "active" });
	mocks.organization.mockResolvedValue({ id: orgB, metadata: {} });
	mocks.upload.mockResolvedValue({ id: "new-image" });
	mocks.request.mockResolvedValue({
		id: "new-image",
		uploadURL: "https://upload.example.test/image",
	});
	mocks.getImage.mockResolvedValue({
		id: "new-image",
		meta: { ...target, organizationId: orgB },
	});
	mocks.getUrl.mockResolvedValue(null);
	mocks.updateUrl.mockResolvedValue(undefined);
});

describe("organization image target membership", () => {
	it.each(["owner", "admin"])(
		"lets a target %s upload from another org without current-org permissions",
		async (role) => {
			mocks.member.mockResolvedValue({ role, status: "active" });
			await client().upload(upload);
			expect(mocks.member).toHaveBeenCalledWith(
				expect.anything(),
				orgB,
				"user-1",
			);
			expect(mocks.upload).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(ArrayBuffer),
				expect.objectContaining({
					metadata: { ...target, organizationId: orgB },
				}),
			);
			expect(mocks.updateUrl).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ ...target, organizationId: orgB }),
			);
		},
	);
	it("supports an account session with no current organization", async () => {
		await client(userContext({ organizationId: null })).upload(upload);
		expect(mocks.updateUrl).toHaveBeenCalled();
	});
	it("uses the canonical user identity when available", async () => {
		await client(userContext({ userId: "canonical-user" })).upload(upload);
		expect(mocks.canonicalMember).toHaveBeenCalledWith(
			expect.anything(),
			orgB,
			"canonical-user",
		);
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it.each([
		{ role: "member", status: "active" },
		{ role: "admin", status: "suspended" },
		{ role: "owner", status: "invited" },
		undefined,
	])(
		"refuses all image writes without active target admin membership: %j",
		async (member) => {
			mocks.member.mockResolvedValue(member);
			const api = client(
				userContext({ permissions: ["settings:manage"], userRole: "owner" }),
			);
			for (const call of [
				() => api.upload(upload),
				() => api.requestUpload(target),
				() => api.confirmUpload({ ...target, imageId: "new-image" }),
				() => api.delete(target),
			]) {
				await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(mocks.upload).not.toHaveBeenCalled();
			expect(mocks.request).not.toHaveBeenCalled();
			expect(mocks.getImage).not.toHaveBeenCalled();
			expect(mocks.remove).not.toHaveBeenCalled();
			expect(mocks.updateUrl).not.toHaveBeenCalled();
		},
	);
	it("authorizes both direct upload steps and deletion against the target", async () => {
		const api = client();
		await api.requestUpload(target);
		await api.confirmUpload({ ...target, imageId: "new-image" });
		await api.delete(target);
		expect(mocks.member).toHaveBeenCalledTimes(3);
		expect(mocks.updateUrl).toHaveBeenLastCalledWith(expect.anything(), {
			...target,
			organizationId: orgB,
			url: null,
		});
	});
	it("refuses a confirmation for an image issued to another target", async () => {
		mocks.getImage.mockResolvedValue({
			id: "new-image",
			meta: { ...target, organizationId: orgA },
		});
		await expect(
			client().confirmUpload({ ...target, imageId: "new-image" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateUrl).not.toHaveBeenCalled();
		expect(mocks.remove).not.toHaveBeenCalled();
	});
	it("keeps machine credentials scoped to their own organization", async () => {
		await expect(
			client(
				apiKeyContext({ organizationId: orgA, scopes: ["platform:admin"] }),
			).upload(upload),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.member).not.toHaveBeenCalled();
		expect(mocks.upload).not.toHaveBeenCalled();
	});
	it("refuses retired organizations", async () => {
		mocks.organization.mockResolvedValue({
			metadata: { retiredAt: "2026-01-01" },
		});
		await expect(client().upload(upload)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.upload).not.toHaveBeenCalled();
	});
});
