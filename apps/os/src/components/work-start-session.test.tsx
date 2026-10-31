import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	WorkItem,
	WorkItemReadinessSchema,
} from "@tedix/api-contract/schemas/work-items";
import type * as z from "zod";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	osQuery,
	userProfileQueryOptions,
	workItemReadinessQueryOptions,
} from "@/lib/os-query-options";
import { WorkExecutorChoice } from "./work-dispatch-app";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	// The oRPC client is a proxy, so replace Work procedures without spreading
	// it; reads other than seeded cache entries stay pending, never on the network.
	const workItems = new Proxy(actual.osApi.workItems, {
		get: (_target, key) =>
			key === "updateSpecification"
				? mocks.update
				: () => new Promise(() => {}),
	});
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workItems" ? workItems : Reflect.get(target, key),
		}),
	};
});

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type WorkItemReadiness = z.infer<typeof WorkItemReadinessSchema>;

const id = "00000001-0000-4000-8000-000000000001";
const ready: WorkItemReadiness = {
	workItemId: id,
	state: "ready",
	ready: true,
	reasons: [],
	derivedAt: "2026-10-26T09:00:00.000Z",
	gates: [],
};
const blocked: WorkItemReadiness = {
	...ready,
	state: "dependencies_blocked",
	ready: false,
	reasons: [
		{ code: "dependencies_blocked", detail: "Blocked by an open dependency" },
	],
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	mocks.update.mockReset();
});

async function render({
	owner = true,
	active = false,
	disposition = "accepted",
	executor = "claude-code",
	readiness = ready,
	attemptStatus = "success",
}: {
	owner?: boolean;
	active?: boolean;
	disposition?: string;
	executor?: string;
	readiness?: WorkItemReadiness;
	attemptStatus?: "success" | "pending" | "error";
} = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryOnMount: false, staleTime: Infinity },
		},
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "owner",
	} as never);
	client.setQueryData(
		osQuery.workItems.listAttempts.queryOptions({ input: { id, limit: 1 } })
			.queryKey,
		{
			data: active
				? [
						{
							id: "00000002-0000-4000-8000-000000000002",
							runtimeState: "running",
							finishedAt: null,
							heartbeatAt: "2026-10-18T17:00:00Z",
							outcome: null,
						},
					]
				: [],
			nextCursor: null,
		} as never,
	);
	if (attemptStatus !== "success") {
		const key = osQuery.workItems.listAttempts.queryOptions({
			input: { id, limit: 1 },
		}).queryKey;
		client.removeQueries({ queryKey: key, exact: true });
		if (attemptStatus === "error") {
			client
				.getQueryCache()
				.build(client, { queryKey: key })
				.setState({
					status: "error",
					error: new Error("Unavailable"),
					fetchStatus: "idle",
				});
		}
	}
	client.setQueryData(workItemReadinessQueryOptions(id).queryKey, readiness);
	const item = {
		id,
		version: 3,
		disposition,
		description: "Ship the example change.",
		accountableOwnerType: "user",
		accountableOwnerId: owner ? "owner" : "another-user",
		metadata: { executor, laneDispatch: { state: "ready" } },
	} as unknown as WorkItem;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkExecutorChoice item={item} />
			</QueryClientProvider>,
		),
	);
	cleanup = async () => {
		await act(async () => root.unmount());
		container.remove();
		client.clear();
	};
	return Object.assign(container, { queryClient: client });
}

const button = (container: HTMLElement, label: string) =>
	[...container.querySelectorAll("button")].find(
		(row) => row.textContent === label,
	);

async function open(container: HTMLElement) {
	await act(async () => button(container, "Start session")?.click());
}

describe("Start session", () => {
	it.each(["human", "tedi"])(
		"keeps non-owner %s Work free of disabled session status",
		async (executor) => {
			const container = await render({
				owner: false,
				executor,
				attemptStatus: "pending",
			});
			expect(container.textContent).not.toContain("Checking session status");
			expect(container.textContent).not.toContain("Queued for");
			for (const queryKey of [
				osQuery.workItems.listAttempts.queryOptions({ input: { id, limit: 1 } })
					.queryKey,
				workItemReadinessQueryOptions(id).queryKey,
			]) {
				const query = container.queryClient
					.getQueryCache()
					.find({ queryKey, exact: true });
				expect(query?.isActive()).toBe(false);
				expect(query?.state.fetchStatus).toBe("idle");
			}
		},
	);

	it.each(["completed", "cancelled", "proposed"])(
		"does not label %s Work as queued",
		async (disposition) => {
			const container = await render({ disposition });
			expect(container.textContent).not.toContain("Queued for");
			expect(container.textContent).not.toContain(
				"Waiting for a connected Mac",
			);
		},
	);
	it.each(["pending", "error"] as const)(
		"keeps %s Attempt status unknown",
		async (attemptStatus) => {
			const container = await render({ attemptStatus });
			expect(container.textContent).not.toContain("Queued for");
			expect(container.textContent).toContain(
				attemptStatus === "pending"
					? "Checking session status"
					: "Session status is unavailable",
			);
		},
	);
	it("shows OpenCode's Attempt for another owner's Work", async () => {
		const container = await render({
			owner: false,
			executor: "opencode",
			active: true,
		});
		expect(container.textContent).toContain("Attempt 00000002 · running");
		expect(container.textContent).not.toContain("Queued for");
	});
	it("shows the observed readiness blocker beside queued Work", async () => {
		const approval = {
			...ready,
			ready: false,
			reasons: [
				{ code: "approval_blocked", detail: "Missing approval risk:high" },
			],
		} as WorkItemReadiness;
		const container = await render({
			owner: false,
			executor: "opencode",
			readiness: approval,
		});
		expect(container.textContent).toContain("Queued for OpenCode.");
		expect(container.textContent).toContain("Missing approval risk:high");
		expect(container.textContent).not.toContain("Start session");
	});

	it.each(["claude-code", "devin"])(
		"offers the owner a start action for accepted %s Work",
		async (executor) => {
			const container = await render({ executor });
			const start = button(container, "Start session");
			expect(start).toBeDefined();
			expect(start?.hasAttribute("disabled")).toBe(false);
			expect(container.textContent).toContain("Queued for");
		},
	);
	it("offers accepted human Work a fresh Codex session", async () => {
		const container = await render({ executor: "human" });
		expect(container.textContent).not.toContain("Waiting for a connected Mac.");
		await open(container);
		expect(container.textContent).toContain("Ready to start.");
		expect(button(container, "Start Codex session")).toBeDefined();
	});
	it("does not offer a start action for another owner's Work or proposed Work", async () => {
		expect((await render({ owner: false })).textContent).not.toContain(
			"Start session",
		);
		await cleanup?.();
		expect(
			(await render({ disposition: "proposed" })).textContent,
		).not.toContain("Start session");
	});
	it("shows the observed Attempt and prevents starting a duplicate live session", async () => {
		const container = await render({ active: true });
		expect(button(container, "Start session")?.hasAttribute("disabled")).toBe(
			true,
		);
		expect(container.textContent).toContain("Attempt 00000002 · running");
		expect(container.textContent).toContain("Last update");
	});
	it("shows why Work is not ready and keeps the start disabled", async () => {
		const container = await render({ readiness: blocked });
		await open(container);
		expect(container.textContent).toContain("Blocked by an open dependency");
		expect(
			button(container, "Start Claude Code session")?.hasAttribute("disabled"),
		).toBe(true);
	});
	it("queues the chosen host with the edited brief on the current version", async () => {
		mocks.update.mockResolvedValue({});
		const container = await render();
		await open(container);
		const brief = container.querySelector<HTMLTextAreaElement>(
			"textarea[aria-label='Brief']",
		);
		expect(brief?.value).toBe("Ship the example change.");
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setValue?.call(brief, "Ship it and attach the proof.");
			brief?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			button(container, "Start Claude Code session")?.click(),
		);
		expect(mocks.update).toHaveBeenCalledWith({
			id,
			expectedWorkItemVersion: 3,
			executor: "claude-code",
			laneDispatch: { state: "ready" },
			description: "Ship it and attach the proof.",
		});
	});
});
