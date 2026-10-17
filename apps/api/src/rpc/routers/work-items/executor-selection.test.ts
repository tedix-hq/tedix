import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	actor: vi.fn(),
	update: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
	workItemStewardActor: mocks.actor,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	updateWorkItemSpecification: mocks.update,
}));
import { updateSpecificationProcedure } from "./factory-lifecycle";
const item = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org-acme",
	version: 2,
};
function select(expectedWorkItemVersion = 2) {
	return updateSpecificationProcedure["~orpc"].handler!({
		input: { id: item.id, executor: "codex", expectedWorkItemVersion },
		context: { db: {} } as BaseContext,
		path: ["workItems", "updateSpecification"],
		procedure: updateSpecificationProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue(item);
	mocks.update.mockResolvedValue(item);
});
it("keeps executor reassignment owner/admin controlled", async () => {
	mocks.actor.mockResolvedValue({ type: "external_agent", id: "local-acme" });
	await expect(select()).rejects.toThrow("owner/admin controlled");
	expect(mocks.update).not.toHaveBeenCalled();
});
it("passes an owner selection through the current Work version fence", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	await select();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			orgId: "org-acme",
			executor: "codex",
			expectedWorkItemVersion: 2,
		}),
	);
	await expect(select(1)).rejects.toThrow("Work changed");
	expect(mocks.update).toHaveBeenCalledTimes(1);
});
