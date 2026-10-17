import { describe, expect, it, vi } from "vite-plus/test";
import { AutomationEventSchema } from "@tedix/api-contract/schemas/automation-events";
import { handleAutomationEventMessage } from "../jobs/automation-events";
import { enqueueRequestFiling } from "./request-filing-queue";
const owner = {
	organizationId: "00000000-0000-4000-8000-000000000001",
	userId: "user-ada",
	ownerSubject: "identity-ada",
};
it("does not let public automation producers choose a private ledger owner", () => {
	expect(
		AutomationEventSchema.safeParse({ kind: "request_filing", ...owner })
			.success,
	).toBe(false);
});
describe("private filing queue", () => {
	it("queues the authenticated owner and acknowledges successful processing", async () => {
		const send = vi.fn(async (_body: unknown) => {});
		const env = { AUTOMATION_EVENTS: { send } } as unknown as CloudflareEnv;
		const boardOwner = { ...owner, descopeUserId: "identity-ada" };
		await enqueueRequestFiling(env, boardOwner);
		expect(send).toHaveBeenCalledWith({ kind: "request_filing", ...owner });
		const fileRequests = vi.fn(async () => {});
		expect(
			await handleAutomationEventMessage(
				env,
				send.mock.calls[0]![0],
				{},
				{ fileRequests },
			),
		).toBe("ack");
		expect(fileRequests).toHaveBeenCalledWith({
			kind: "request_filing",
			...owner,
		});
	});
	it("retries transient failures and acknowledges malformed messages without processing", async () => {
		const env = {} as CloudflareEnv;
		const fileRequests = vi.fn(async () => {
			throw new Error("Temporary model outage");
		});
		expect(
			await handleAutomationEventMessage(
				env,
				{ kind: "request_filing", ...owner },
				{},
				{ fileRequests },
			),
		).toBe("retry");
		expect(
			await handleAutomationEventMessage(
				env,
				{ kind: "request_filing", ...owner, userId: null },
				{},
				{ fileRequests },
			),
		).toBe("ack");
		expect(fileRequests).toHaveBeenCalledOnce();
		await expect(enqueueRequestFiling(env, owner)).rejects.toThrow(
			"queue unavailable",
		);
	});
});
