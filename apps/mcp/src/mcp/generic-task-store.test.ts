import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// In-memory fake of the slice of the drizzle client the store uses.
// Keyed by taskId so we can assert the row transitions.
type Row = Record<string, unknown>;
const rows: Row[] = [];

function fakeDb() {
	return {
		insert() {
			return {
				async values(row: Row) {
					rows.push({ ...row });
				},
			};
		},
		select(_columns?: Record<string, unknown>) {
			return {
				from() {
					return {
						where(predicate: (r: Row) => boolean) {
							return {
								async limit() {
									return rows.filter(predicate);
								},
							};
						},
					};
				},
			};
		},
		update() {
			return {
				set(patch: Row) {
					return {
						async where(predicate: (r: Row) => boolean) {
							for (const row of rows) {
								if (predicate(row)) Object.assign(row, patch);
							}
						},
					};
				},
			};
		},
	};
}

// drizzle's eq() returns an opaque SQL node; our fake `where` expects a
// predicate, so we mock eq() to build a taskId-matching predicate.
vi.mock("drizzle-orm", () => ({
	eq: (_col: unknown, value: unknown) => (r: Row) => r.taskId === value,
}));

vi.mock("@tedix/db/client", () => ({
	createDbClient: () => fakeDb(),
}));

vi.mock("@tedix/db/schema/mcp-tasks", () => ({
	mcpTasks: {
		taskId: "task_id",
		cancelRequestedAt: "cancel_requested_at",
	},
}));

import {
	cancelGenericTask,
	createGenericTask,
	getGenericTaskState,
	isGenericTaskId,
	newGenericTaskId,
	updateGenericTaskInput,
} from "./generic-task-store";

const D1 = {} as unknown as D1Database;
const ORG = "org-1";

beforeEach(() => {
	rows.length = 0;
});

describe("generic task store", () => {
	it("mints namespaced generic-<uuid> ids", () => {
		const id = newGenericTaskId();
		expect(id.startsWith("generic-")).toBe(true);
		expect(isGenericTaskId(id)).toBe(true);
		expect(isGenericTaskId("tedi:x:y")).toBe(false);
		expect(isGenericTaskId("bare-run-id")).toBe(false);
	});

	it("creates a working task and projects it to McpTaskState", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
			inputArgs: { a: 1 },
		});
		const state = await getGenericTaskState(D1, taskId, ORG);
		expect(state.status).toBe("working");
		expect(state.taskId).toBe(taskId);
		expect(typeof state.pollIntervalMs).toBe("number");
		expect(state.ttlMs).toBeGreaterThan(0);
	});

	it("returns -32602 for an unknown id and for a foreign org", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
		});
		await expect(
			getGenericTaskState(D1, "generic-missing", ORG),
		).rejects.toMatchObject({
			code: -32_602,
		});
		await expect(
			getGenericTaskState(D1, taskId, "other-org"),
		).rejects.toMatchObject({
			code: -32_602,
		});
	});

	it("hides a user-owned task from another user in the same org", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
			caller: { userId: "user-a" },
		});
		expect(rows.find((row) => row.taskId === taskId)?.subjectUserId).toBe(
			"user-a",
		);
		await expect(
			getGenericTaskState(D1, taskId, ORG, "user-b"),
		).rejects.toMatchObject({ code: -32_602 });
		await expect(
			cancelGenericTask(D1, taskId, ORG, "user-b"),
		).rejects.toMatchObject({ code: -32_602 });
		await expect(
			updateGenericTaskInput(D1, taskId, ORG, {}, "user-b"),
		).rejects.toMatchObject({ code: -32_602 });
		await expect(
			getGenericTaskState(D1, taskId, ORG, "user-a"),
		).resolves.toMatchObject({
			taskId,
		});
	});

	it("cancel marks the task cancelled and is idempotently terminal", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
		});
		const state = await cancelGenericTask(D1, taskId, ORG);
		expect(state.status).toBe("cancelled");
		// Cancelling again on a terminal task errors.
		await expect(cancelGenericTask(D1, taskId, ORG)).rejects.toMatchObject({
			code: -32_000,
		});
	});

	it("update stores input responses (MRTR)", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
		});
		await updateGenericTaskInput(D1, taskId, ORG, { answer: "yes" });
		const row = rows.find((r) => r.taskId === taskId);
		expect(row?.inputResponses).toMatchObject({ answer: "yes" });
	});

	it("snapshots the exec-config alongside the input for the workflow", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "home__async_canary",
			inputArgs: { limit: 5 },
			execConfig: {
				transport: "rpc",
				endpoint: "kernelRuntime/readRunSet",
				responsePath: "json",
			},
		});
		const row = rows.find((r) => r.taskId === taskId);
		expect(row?.inputRequests).toMatchObject({
			input: { limit: 5 },
			execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
		});
	});

	it("persists the caller identity-references block into inputRequests", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "home__async_canary",
			inputArgs: { limit: 5 },
			execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
			caller: {
				authType: "oauth",
				userId: "user-uuid",
				organizationId: ORG,
				clientId: "oauth-client-id",
				connectionLabel: "promptwatch",
			},
		});
		const row = rows.find((r) => r.taskId === taskId);
		expect(row?.inputRequests).toMatchObject({
			input: { limit: 5 },
			execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
			caller: {
				authType: "oauth",
				userId: "user-uuid",
				organizationId: ORG,
				clientId: "oauth-client-id",
				connectionLabel: "promptwatch",
			},
		});
	});

	it("NEVER persists a token/bearer or scopes/credentialMode in the caller block", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "home__async_canary",
			inputArgs: { limit: 5 },
			caller: {
				authType: "tedi",
				tediId: "tedi-uuid",
				organizationId: ORG,
				kernel: true,
			},
		});
		const row = rows.find((r) => r.taskId === taskId);
		const serialized = JSON.stringify(row?.inputRequests);
		// Negative: no credential/token-shaped key may leak into the durable row.
		for (const forbidden of [
			"token",
			"bearer",
			"bearerToken",
			"accessToken",
			"access_token",
			"Authorization",
			"authorization",
		]) {
			expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
		}
		const caller = (row?.inputRequests as { caller?: Record<string, unknown> })
			?.caller;
		expect(caller).toBeDefined();
		// Negative: scopes and credentialMode are deliberately not captured.
		expect(caller).not.toHaveProperty("scopes");
		expect(caller).not.toHaveProperty("credentialMode");
		expect(caller).not.toHaveProperty("token");
		expect(caller).not.toHaveProperty("bearerToken");
		expect(caller).not.toHaveProperty("accessToken");
		// Positive: only the allowed identity references survive.
		expect(caller).toMatchObject({
			authType: "tedi",
			tediId: "tedi-uuid",
			organizationId: ORG,
			kernel: true,
		});
	});

	it("omits the caller block entirely when no caller is captured", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
			inputArgs: { a: 1 },
		});
		const row = rows.find((r) => r.taskId === taskId);
		expect(row?.inputRequests).not.toHaveProperty("caller");
	});

	it("projects an expired working task as failed", async () => {
		const taskId = newGenericTaskId();
		await createGenericTask({
			db: D1,
			taskId,
			orgId: ORG,
			appId: "app-1",
			toolName: "do_thing",
			ttlMs: 1,
		});
		// Force expiry.
		const row = rows.find((r) => r.taskId === taskId);
		if (row) row.expiresAt = new Date(Date.now() - 1000).toISOString();
		const state = await getGenericTaskState(D1, taskId, ORG);
		expect(state.status).toBe("failed");
		expect(state.error?.code).toBe(-32_603);
	});
});
