import { call, os } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import * as z from "zod";
import type { BaseContext } from "../rpc/context";
const mocks = vi.hoisted(() => ({ reference: vi.fn() }));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectById: async () => ({
		id: "private-reviews",
		orgId: "fictional-org",
		leadTediId: "fictional-triage",
	}),
}));
vi.mock("@tedix/db/queries/work-items/project-access", () => ({
	hasProjectWorkItemReference: mocks.reference,
}));
import { withAuth } from "../rpc/orpc";

function context(tediId: string) {
	return {
		env: { AGENT_REVIEW_PROJECT_ID: "private-reviews" },
		db: {},
		organizationId: "fictional-org",
		url: new URL("https://api.example.test/rpc/workItems/getById"),
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Id": tediId,
		}),
	} as unknown as BaseContext;
}
beforeEach(() => {
	mocks.reference.mockImplementation(async (_db, { ids }) =>
		ids.includes("private-work"),
	);
});
it("enforces the private input fence through real authentication middleware", async () => {
	const handler = vi.fn(async () => "private report");
	const procedure = os
		.$context<BaseContext>()
		.use(withAuth)
		.input(z.object({ id: z.string() }))
		.handler(handler);
	await expect(
		call(
			procedure,
			{ id: "private-work" },
			{ context: context("other-worker") },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(handler).not.toHaveBeenCalled();
	await expect(
		call(
			procedure,
			{ id: "private-work" },
			{ context: context("fictional-triage") },
		),
	).resolves.toBe("private report");
});
it("enforces the private output fence through real authentication middleware", async () => {
	const procedure = os
		.$context<BaseContext>()
		.use(withAuth)
		.handler(async () => ({
			data: [{ projectId: "private-reviews", description: "private report" }],
		}));
	await expect(
		call(procedure, undefined, { context: context("other-worker") }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("allows authenticated local RPCs despite the example review-project placeholder", async () => {
	const local = context("local-worker");
	local.env = {
		...local.env,
		ENVIRONMENT: "development",
		DESCOPE_PROJECT_ID: "local-development-disabled",
		AGENT_REVIEW_PROJECT_ID: "configured-via-private-overlay",
	};
	const procedure = os
		.$context<BaseContext>()
		.use(withAuth)
		.handler(async () => "local onboarding works");
	await expect(call(procedure, undefined, { context: local })).resolves.toBe(
		"local onboarding works",
	);
});
