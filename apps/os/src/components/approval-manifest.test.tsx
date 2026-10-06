import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	getReviewManifest: vi.fn(),
	resolveReviewManifest: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { tediApprovals: api } }));
import {
	ApprovalManifestActions,
	ApprovalManifestReview,
} from "./approval-manifest";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = "00000000-0000-4000-8000-000000000001";
const hash = `sha256:${"a".repeat(64)}`;
const approval: ApprovalRequest = {
	id,
	tediId: id,
	orgId: id,
	actionType: "home_tool_write",
	description:
		"Create the exact approved draft, preserving the complete description.",
	payload: { args: { title: "Exact draft" } },
	status: "pending",
	createdAt: "2026-09-22T10:00:00Z",
	expiresAt: "2099-09-22T10:00:00Z",
	resolvedAt: null,
	resolvedBy: null,
	resolution: null,
	workflowId: null,
	review: {
		intent: "tool_write",
		state: "requires_decision",
		decisionMode: "approve_or_reject",
		outcome: null,
		safetyDefault: "deny_on_timeout",
		summary: "Create draft",
		operatorQuestion: "Create this draft?",
		timeout: {
			expired: false,
			terminalStatus: null,
			defaultDecision: null,
			reason: "Pending",
		},
		evidenceRefs: [],
		interaction: null,
	},
};
const manifest = {
	manifestHash: hash,
	generatedAt: "2026-09-22T10:00:00Z",
	actions: [
		{
			order: 1,
			inclusion: "requested" as const,
			canonicalInputHash: hash,
			approval,
			dependencies: [],
			vetoCascadeApprovalRequestIds: ["00000000-0000-4000-8000-000000000002"],
			execution: { state: "none" as const, receiptId: null },
		},
	],
};
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	client?.clear();
	vi.clearAllMocks();
});

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<ApprovalManifestReview approvalRequestIds={[id]} onClose={vi.fn()} />
			</QueryClientProvider>,
		);
	});
	await vi.waitFor(() =>
		expect(host.textContent).toContain(approval.description),
	);
}
function button(label: string) {
	const found = [...host.querySelectorAll("button")].find(
		(node) => node.textContent === label,
	);
	if (!found) throw new Error(`Missing ${label}`);
	return found;
}

describe("Ordered exact approval review", () => {
	it("discloses complete description, exact payload/hash and veto consequences", () => {
		const html = renderToStaticMarkup(
			<ApprovalManifestActions
				manifest={manifest}
				decisions={{}}
				disabled={false}
				onDecision={vi.fn()}
			/>,
		);
		expect(html).toContain(approval.description);
		expect(html).toContain("Exact draft");
		expect(html).toContain(hash);
		expect(html).toContain("tediId");
		expect(html).toContain("organizationId");
		expect(html).toContain("expiresAt");
		expect(html).toContain("timeout");
		expect(html).toContain("Veto also cancels");
		expect(html).toContain("Selected");
		expect(html).toContain(
			manifest.actions[0]!.vetoCascadeApprovalRequestIds[0],
		);
		expect(html).not.toContain("Approve all");
	});
	it("discloses actions added by hard dependency expansion", () => {
		const html = renderToStaticMarkup(
			<ApprovalManifestActions
				manifest={{
					...manifest,
					actions: [
						{
							...manifest.actions[0]!,
							inclusion: "hard_dependency_component",
						},
					],
				}}
				decisions={{}}
				disabled={false}
				onDecision={vi.fn()}
			/>,
		);
		expect(html).toContain("Included by hard dependency graph");
	});
	it("blocks unsupported hard dependencies but keeps veto available", async () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<ApprovalManifestActions
					manifest={{
						...manifest,
						actions: [
							{
								...manifest.actions[0]!,
								dependencies: [
									{
										declarationEventId: "edge",
										prerequisiteApprovalRequestId: id,
										kind: "hard",
										enforcement: "unsupported_baseline_verifier",
									},
								],
							},
						],
					}}
					decisions={{}}
					disabled={false}
					onDecision={vi.fn()}
				/>,
			),
		);
		expect(button("Choose approval").disabled).toBe(true);
		expect(button("Choose veto").disabled).toBe(false);
		expect(host.textContent).toContain("baseline verification unavailable");
	});
	it("disables decisions for a request whose wall-clock expiry has passed", async () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<ApprovalManifestActions
					manifest={{
						...manifest,
						actions: [
							{
								...manifest.actions[0]!,
								approval: {
									...approval,
									expiresAt: "2000-01-01T00:00:00Z",
								},
							},
						],
					}}
					decisions={{}}
					disabled={false}
					onDecision={vi.fn()}
				/>,
			),
		);
		expect(button("Choose approval").disabled).toBe(true);
		expect(button("Choose veto").disabled).toBe(true);
	});
	it("submits only explicit hash-bound choices and shows per-request results", async () => {
		api.getReviewManifest.mockResolvedValue(manifest);
		api.resolveReviewManifest.mockResolvedValue({
			manifest,
			results: [
				{
					approvalRequestId: id,
					outcome: "approved",
					reason: "Exact action executed",
				},
			],
		});
		await mount();
		expect(button("Submit explicit decisions").disabled).toBe(true);
		await act(async () => button("Choose approval").click());
		await act(async () => button("Submit explicit decisions").click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Observed outcomes"),
		);
		expect(api.resolveReviewManifest).toHaveBeenCalledTimes(1);
		expect(api.resolveReviewManifest.mock.calls[0]?.[0]).toEqual({
			approvalRequestIds: [id],
			expectedManifestHash: hash,
			decisions: [
				{
					approvalRequestId: id,
					expectedCanonicalInputHash: hash,
					decision: "approve",
				},
			],
		});
		expect(button("Submit explicit decisions").disabled).toBe(true);
	});
	it("never retries uncertain writes and requires fresh review before new choices", async () => {
		api.getReviewManifest.mockResolvedValue(manifest);
		api.resolveReviewManifest.mockRejectedValue(
			new Error("Response unavailable"),
		);
		await mount();
		await act(async () => button("Choose veto").click());
		await act(async () => button("Submit explicit decisions").click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Response unavailable"),
		);
		expect(api.resolveReviewManifest).toHaveBeenCalledTimes(1);
		expect(button("Submit explicit decisions").disabled).toBe(true);
		expect(button("Choose approval").disabled).toBe(true);
		await act(async () => button("Refresh review").click());
		await vi.waitFor(() =>
			expect(button("Choose approval").disabled).toBe(false),
		);
		expect(button("Submit explicit decisions").disabled).toBe(true);
		expect(api.resolveReviewManifest).toHaveBeenCalledTimes(1);
	});
	it("announces unknown outcomes and warns when reconciliation is required", async () => {
		api.getReviewManifest.mockResolvedValue(manifest);
		api.resolveReviewManifest.mockResolvedValue({
			manifest,
			results: [
				{
					approvalRequestId: id,
					outcome: "unknown",
					reason: "Provider response unavailable",
				},
			],
		});
		await mount();
		await act(async () => button("Choose veto").click());
		await act(async () => button("Submit explicit decisions").click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Reconciliation required"),
		);
		expect(
			host
				.querySelector('[aria-label="Per-request outcomes"]')
				?.getAttribute("aria-live"),
		).toBe("polite");
		expect(button("Submit explicit decisions").disabled).toBe(true);
	});
	it("keeps an in-flight decision locked across a background snapshot change", async () => {
		api.getReviewManifest.mockResolvedValue(manifest);
		let finish: ((value: unknown) => void) | undefined;
		api.resolveReviewManifest.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await mount();
		await act(async () => button("Choose veto").click());
		await act(async () => button("Submit explicit decisions").click());
		api.getReviewManifest.mockResolvedValue({
			...manifest,
			manifestHash: `sha256:${"c".repeat(64)}`,
		});
		await act(async () => {
			await client.invalidateQueries();
		});
		expect(button("Close review").disabled).toBe(true);
		expect(button("Choose approval").disabled).toBe(true);
		expect(button("Submit explicit decisions").disabled).toBe(true);
		await act(async () =>
			finish?.({
				manifest,
				results: [
					{
						approvalRequestId: id,
						outcome: "unknown",
						reason: "Response unavailable",
					},
				],
			}),
		);
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Reconciliation required"),
		);
		expect(button("Choose approval").disabled).toBe(true);
		expect(api.resolveReviewManifest).toHaveBeenCalledTimes(1);
	});
	it("clears choices when a refreshed manifest hash changes", async () => {
		api.getReviewManifest.mockResolvedValue(manifest);
		await mount();
		await act(async () => button("Choose approval").click());
		expect(button("Choose approval").getAttribute("aria-pressed")).toBe("true");
		const nextHash = `sha256:${"b".repeat(64)}`;
		api.getReviewManifest.mockResolvedValue({
			...manifest,
			manifestHash: nextHash,
			actions: [
				{
					...manifest.actions[0]!,
					canonicalInputHash: nextHash,
					approval: { ...approval, description: "Changed exact request" },
				},
			],
		});
		await act(async () => {
			await client.invalidateQueries();
		});
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Changed exact request"),
		);
		expect(button("Choose approval").getAttribute("aria-pressed")).toBe(
			"false",
		);
		expect(button("Submit explicit decisions").disabled).toBe(true);
	});
});
