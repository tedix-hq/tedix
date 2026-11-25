import { createRouterClient } from "@orpc/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { repositoryObserverContractRouter } from "./repository-observer";

const mocks = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("../../jobs/commit-alias-counts", () => ({
	countCommitAliasPage: mocks.count,
}));
const input = {
	repository: "example/project",
	quietHoursUtc: { start: 1, end: 5 },
};
function client(platform: boolean) {
	const context = {
		authType: "user",
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc"),
		user: {
			sub: "user-1",
			roles: platform ? ["platform-admin"] : ["org-admin"],
			permissions: ["settings:manage"],
		},
	} as unknown as BaseContext;
	return createRouterClient(repositoryObserverContractRouter, { context });
}
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("refuses tenant administrators and calls outside quiet hours before any count reads", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
	await expect(client(false).countCommitAliases(input)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
	await expect(client(true).countCommitAliases(input)).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	expect(mocks.count).not.toHaveBeenCalled();
});

it("admits the platform operator during quiet hours and refuses a cross-repository cursor", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
	mocks.count.mockResolvedValue({
		status: "no_aliases",
		cursor: null,
		location: "work_attempts.metadata",
		store: "main",
		locationComplete: false,
		scanned: 0,
		locked: 0,
		unlocked: 0,
		inFlightAttemptIds: [],
		openObserverWorkItemIds: [],
	});
	expect(await client(true).countCommitAliases(input)).toMatchObject({
		status: "no_aliases",
	});
	expect(mocks.count).toHaveBeenCalledTimes(1);
	await expect(
		client(true).countCommitAliases({
			...input,
			cursor: {
				runId: "00000000-0000-4000-8000-000000000001",
				repository: "example/other",
				location: "work_attempts.metadata",
				store: "main",
				after: "",
				scanned: 0,
				locked: 0,
				unlocked: 0,
			},
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(mocks.count).toHaveBeenCalledTimes(1);
});
