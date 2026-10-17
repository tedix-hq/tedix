import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({ readContinuity: vi.fn() }));
vi.mock("../../lib/stall-attention", () => mocks);

function client(
	permissions: string[],
	organizationId: string | undefined = "fictional-orchard",
) {
	return createRouterClient(projectsContractRouter, {
		context: {
			authType: "user",
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			organizationId,
			url: new URL("https://api.tedix.test/rpc/projects"),
			user: {
				aud: "test",
				dct: "tenant",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions,
				roles: [],
				sub: "ada",
			},
		} as BaseContext,
	});
}

describe("coordinator continuity report", () => {
	it("reads only the authenticated tenant and preserves the bounded cursor", async () => {
		mocks.readContinuity.mockResolvedValueOnce({
			stalls: [],
			promises: [],
			next: "project:next",
		});
		expect(
			await client(["tedis:read"]).getContinuity({ after: "project:previous" }),
		).toEqual({ stalls: [], promises: [], next: "project:next" });
		expect(mocks.readContinuity).toHaveBeenCalledWith(
			{},
			"fictional-orchard",
			expect.any(Date),
			"project:previous",
			undefined,
			"test",
		);
	});
	it("rejects missing read permission", async () => {
		await expect(client([]).getContinuity({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
