import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	permissions: [] as string[],
}));
vi.mock("@/lib/api", () => ({
	osApi: { tedis: { inspectRuntimeRecovery: mocks.inspect } },
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: { permissions: mocks.permissions } },
	}),
}));
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	TediRecoveryDiagnostic,
	RecoveryDiagnosticResult,
} from "./tedi-recovery-diagnostic";

describe("runtime recovery diagnostic result", () => {
	it("shows unknown and failed reads without claiming idle", () => {
		expect(renderToStaticMarkup(<RecoveryDiagnosticResult />)).toContain(
			"unknown until",
		);
		const failed = renderToStaticMarkup(<RecoveryDiagnosticResult error />);
		expect(failed).toContain("Session state is unknown");
		expect(failed).not.toContain("Live tasks: 0");
		expect(
			renderToStaticMarkup(<RecoveryDiagnosticResult pending />),
		).toContain("Reading recovery state");
	});
	it("shows bounded native metadata and explicit truncation", () => {
		const html = renderToStaticMarkup(
			<RecoveryDiagnosticResult
				data={{
					ok: true,
					runtime: "pi",
					sessionKey: "session",
					sampledAt: "2026-10-04T12:00:00.000Z",
					conversationId: 1,
					scheduling: "paused",
					operation: null,
					tasks: [
						{
							id: 1,
							conversationId: 1,
							kind: "native.tool",
							owner: null,
							background: false,
							abortRequested: true,
							status: "pending",
							view: "blocked",
							blockedReason: "missing_task",
							waitingOn: [],
							waitingOnTruncated: false,
						},
					],
					submissions: [],
					taskCount: 60,
					submissionCount: 0,
					truncated: true,
				}}
			/>,
		);
		expect(html).toContain("missing_task");
		expect(html).toContain("cancellation requested");
		expect(html).toContain("first 50");
		expect(html).toContain("Live tasks: 60");
	});
});

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((run) => run());
	mocks.inspect.mockReset();
	mocks.permissions = [];
});
async function mountDiagnostic() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<TediRecoveryDiagnostic tediId="11111111-1111-4111-8111-111111111111" />
			</QueryClientProvider>,
		),
	);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		host.remove();
	});
	return Object.assign(host, {
		rerender: async (tediId: string) => {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<TediRecoveryDiagnostic tediId={tediId} />
					</QueryClientProvider>,
				),
			);
		},
	});
}
it("does not expose the panel without platform administrator permission", async () => {
	const host = await mountDiagnostic();
	expect(host.textContent).toBe("");
	expect(mocks.inspect).not.toHaveBeenCalled();
});
it("reads only after an explicit operator click and does not fetch while editing", async () => {
	mocks.permissions = ["platform:admin"];
	mocks.inspect.mockRejectedValue(new Error("unavailable"));
	const host = await mountDiagnostic();
	expect(mocks.inspect).not.toHaveBeenCalled();
	const input = host.querySelector<HTMLInputElement>(
		'input[aria-label="Exact session key"]',
	)!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, "existing-session");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(mocks.inspect).not.toHaveBeenCalled();
	await act(async () => {
		host.querySelector<HTMLButtonElement>("button")!.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(mocks.inspect).toHaveBeenCalledOnce();
	expect(mocks.inspect.mock.calls[0]?.[0]).toEqual({
		tediId: "11111111-1111-4111-8111-111111111111",
		sessionKey: "existing-session",
	});
	expect(host.textContent).toContain("Session state is unknown");
	await host.rerender("22222222-2222-4222-8222-222222222222");
	expect(mocks.inspect).toHaveBeenCalledOnce();
	expect(host.textContent).toContain("unknown until");
	expect(host.textContent).not.toContain("Session state is unknown");
	await act(async () => {
		host.querySelector<HTMLButtonElement>("button")!.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(mocks.inspect).toHaveBeenCalledTimes(2);
	expect(mocks.inspect.mock.calls[1]?.[0]).toMatchObject({
		tediId: "22222222-2222-4222-8222-222222222222",
	});
});
