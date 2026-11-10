import "./__tests__/kernel-runtime-work-mocks";
import * as grants from "@tedix/db/queries/kernel-conversation-access";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ORG_ID,
	createContext,
	createKernelRuntimeClient,
	createKernelRuntimeDb,
	grantRow,
	normalizeKernelRuntimeRunInsert,
} from "./__tests__/kernel-runtime-db";

describe("Home event reads during a grant lookup outage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns SERVICE_UNAVAILABLE without settling the Home run or its delegation, then resumes", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-overload",
				organizationId: ORG_ID,
				conversationId: "home:overload",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-overload",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const before = structuredClone(db.runs);
		const lookup = vi
			.spyOn(grants, "listKernelConversationGrants")
			.mockRejectedValue(new Error("D1_ERROR: overloaded"));
		await expect(
			client.readRunEvents({ runId: "home-overload", offset: 0 }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(db.runs).toEqual(before);
		expect(db.events).toEqual([]);
		lookup.mockRestore();
		await expect(
			client.readRunEvents({ runId: "home-overload", offset: 0 }),
		).resolves.toMatchObject({ stream: { offset: 0, closed: false } });
		expect(db.runs[0]).toMatchObject({
			status: "running",
			childRunId: "child-overload",
		});
	});

	it("keeps a real grant denial FORBIDDEN", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					conversationId: "home:private",
					userId: "someone-else",
					access: "owner",
				}),
			],
		});
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "private-run",
				organizationId: ORG_ID,
				conversationId: "home:private",
				status: "running",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.readRunEvents({ runId: "private-run" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
