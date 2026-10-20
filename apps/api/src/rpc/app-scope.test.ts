import { ORPCError } from "@orpc/client";
import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: mocks.getAppById,
}));

import { requireAppForOrg, requireAppForOrgOrNotFound } from "./app-scope";

const db = {} as DbClient;
const ownedApp = { id: "app_1", organizationId: "org_1" };
const foreignApp = { id: "app_2", organizationId: "org_other" };
const unownedApp = { id: "app_3", organizationId: null };

async function failureOf(
	promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError)
			return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("expected a throw");
}

beforeEach(() => {
	mocks.getAppById.mockReset();
});

describe("requireAppForOrg", () => {
	it("returns the app when the organization owns it", async () => {
		mocks.getAppById.mockResolvedValue(ownedApp);
		await expect(requireAppForOrg(db, "org_1", "app_1")).resolves.toBe(
			ownedApp,
		);
		expect(mocks.getAppById).toHaveBeenCalledWith(db, "app_1");
	});

	it("rejects an unknown app with NOT_FOUND", async () => {
		mocks.getAppById.mockResolvedValue(undefined);
		expect(await failureOf(requireAppForOrg(db, "org_1", "missing"))).toEqual({
			code: "NOT_FOUND",
			message: "App not found",
		});
	});

	// The five routers that shared this body all distinguished "exists but is
	// not yours" from "does not exist"; that contract is preserved here.
	it("rejects another organization's app with FORBIDDEN", async () => {
		mocks.getAppById.mockResolvedValue(foreignApp);
		expect(await failureOf(requireAppForOrg(db, "org_1", "app_2"))).toEqual({
			code: "FORBIDDEN",
			message: "You do not have access to this app",
		});
	});

	it("rejects an app with no organization with FORBIDDEN", async () => {
		mocks.getAppById.mockResolvedValue(unownedApp);
		expect(await failureOf(requireAppForOrg(db, "org_1", "app_3"))).toEqual({
			code: "FORBIDDEN",
			message: "You do not have access to this app",
		});
	});
});

describe("requireAppForOrgOrNotFound", () => {
	it("returns the app when the organization owns it", async () => {
		mocks.getAppById.mockResolvedValue(ownedApp);
		await expect(
			requireAppForOrgOrNotFound(db, "org_1", "app_1"),
		).resolves.toBe(ownedApp);
	});

	it("rejects an unknown app with NOT_FOUND", async () => {
		mocks.getAppById.mockResolvedValue(undefined);
		expect(
			await failureOf(requireAppForOrgOrNotFound(db, "org_1", "missing")),
		).toEqual({ code: "NOT_FOUND", message: "App not found" });
	});

	// mcp-server deliberately does not reveal whether a foreign app id exists.
	it("rejects another organization's app with NOT_FOUND, not FORBIDDEN", async () => {
		mocks.getAppById.mockResolvedValue(foreignApp);
		expect(
			await failureOf(requireAppForOrgOrNotFound(db, "org_1", "app_2")),
		).toEqual({ code: "NOT_FOUND", message: "App not found" });
	});
});
