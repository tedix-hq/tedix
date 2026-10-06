import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ApprovalProvenance } from "@tedix/api-contract/contracts/tedi-approvals";

const api = vi.hoisted(() => ({ getProvenance: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { tediApprovals: api } }));
import {
	ApprovalProvenanceDisclosure,
	ApprovalProvenanceHistory,
} from "./approval-provenance";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = "10000000-0000-4000-8000-000000000001";
const simulation: ApprovalProvenance["simulations"]["records"][number] = {
	id: "sim-1",
	organizationId: "org-1",
	approvalRequestId: id,
	simulatorId: "draft-preview",
	simulatorVersion: "1",
	canonicalInputHash: "sha256:input",
	recordHash: "sha256:record",
	baselineEvidenceRefs: [{ ref: "draft://base", revision: "1" }],
	predictedResult: { title: "Predicted draft" },
	assumptions: [{ name: "local", value: true }],
	confidence: 0.9,
	evidenceKind: "simulation",
	notProof: true,
	createdAt: "2026-10-02T00:00:00Z",
};
const receipt: ApprovalProvenance["executionReceipts"]["records"][number] = {
	id: "receipt-1",
	organizationId: "org-1",
	approvalRequestId: id,
	simulationId: "sim-1",
	idempotencyKey: "execute-1",
	canonicalInputHash: "sha256:input",
	recordHash: "sha256:receipt",
	evidenceKind: "execution_receipt",
	baselineFenceOutcome: "matched",
	outcome: "succeeded",
	observedResult: { title: "Observed draft" },
	observedError: null,
	providerReceiptRefs: [{ provider: "tedix", ref: "draft-1" }],
	executedAt: "2026-10-02T01:00:00Z",
	createdAt: "2026-10-02T01:00:00Z",
};
function provenance(): ApprovalProvenance {
	return {
		approvalRequestId: id,
		simulations: { records: [simulation], nextCursor: null },
		executionReceipts: { records: [receipt], nextCursor: null },
	};
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
const copy = vi.fn();
beforeEach(() => {
	api.getProvenance.mockReset().mockResolvedValue(provenance());
	api.list.mockReset().mockImplementation(async (input) => ({
		data: [
			{
				id,
				description: "Create the exact approved draft",
				status: input.status,
			},
		],
		pagination: {
			limit: 10,
			offset: input.offset,
			total: 20,
			hasMore: input.offset === 0,
		},
	}));
	copy.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: copy },
	});
});
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
});
async function mount(history = false) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				{history ? (
					<ApprovalProvenanceHistory />
				) : (
					<ApprovalProvenanceDisclosure approvalRequestId={id} />
				)}
			</QueryClientProvider>,
		),
	);
}
async function open() {
	await act(async () => {
		const disclosure = host.querySelector("details")!;
		disclosure.open = true;
		disclosure.dispatchEvent(new Event("toggle"));
	});
}
function button(label: string) {
	const result = [...host.querySelectorAll("button")].find(
		(item) => item.textContent === label,
	);
	if (!result) throw new Error(`Missing button ${label}`);
	return result;
}

describe("read-only runtime approval history", () => {
	it("loads completed requests lazily and exposes their receipts without any decision controls", async () => {
		await mount(true);
		expect(api.list).not.toHaveBeenCalled();
		await open();
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Create the exact approved draft"),
		);
		expect(api.list.mock.lastCall?.[0]).toEqual({
			status: "approved",
			offset: 0,
			limit: 10,
		});
		expect(api.getProvenance).not.toHaveBeenCalled();
		expect(host.textContent).not.toContain("Choose approval");
		expect(host.textContent).not.toContain("Choose veto");
		await act(async () => {
			const disclosure = host.querySelectorAll("details")[1]!;
			disclosure.open = true;
			disclosure.dispatchEvent(new Event("toggle"));
		});
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Observed execution: succeeded"),
		);
	});
	it("pages past requests and resets the page when terminal status changes", async () => {
		await mount(true);
		await open();
		await vi.waitFor(() =>
			expect(button("Next requests").disabled).toBe(false),
		);
		await act(async () => button("Next requests").click());
		await vi.waitFor(() =>
			expect(api.list.mock.lastCall?.[0]).toEqual({
				status: "approved",
				offset: 10,
				limit: 10,
			}),
		);
		await vi.waitFor(() => expect(button("Next requests").disabled).toBe(true));
		await act(async () => button("Rejected").click());
		await vi.waitFor(() =>
			expect(api.list.mock.lastCall?.[0]).toEqual({
				status: "rejected",
				offset: 0,
				limit: 10,
			}),
		);
		await vi.waitFor(() =>
			expect(button("Previous requests").disabled).toBe(true),
		);
		await act(async () => button("Expired").click());
		await vi.waitFor(() =>
			expect(api.list.mock.lastCall?.[0]).toEqual({
				status: "expired",
				offset: 0,
				limit: 10,
			}),
		);
		await act(async () => button("Cancelled").click());
		await vi.waitFor(() =>
			expect(api.list.mock.lastCall?.[0]).toEqual({
				status: "cancelled",
				offset: 0,
				limit: 10,
			}),
		);
	});
	it("distinguishes missing history from unavailable history and permits retry", async () => {
		api.list.mockRejectedValueOnce(new Error("read failed")).mockResolvedValue({
			data: [],
			pagination: { limit: 10, offset: 0, total: 0, hasMore: false },
		});
		await mount(true);
		await open();
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Approval history unavailable"),
		);
		expect(host.textContent).not.toContain("No approved requests");
		await act(async () => button("Retry approval history").click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("No approved requests in this page."),
		);
		expect(api.getProvenance).not.toHaveBeenCalled();
	});
});

describe("approval provenance disclosure", () => {
	it("loads only on opening and copies the complete marked prediction separately from observation", async () => {
		await mount();
		expect(api.getProvenance).not.toHaveBeenCalled();
		await open();
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Simulated — not executed"),
		);
		expect(host.textContent).toContain("not proof of an effect");
		expect(host.textContent).toContain("Observed execution: succeeded");
		await act(async () => button("Copy").click());
		expect(JSON.parse(copy.mock.calls[0]![0])).toEqual(simulation);
		await act(async () => button("Copy").click());
		expect(JSON.parse(copy.mock.calls[1]![0])).toEqual(receipt);
		expect(host.textContent).toContain("Observed draft");
	});
	it("shows empty histories without inventing execution from approval", async () => {
		api.getProvenance.mockResolvedValue({
			approvalRequestId: id,
			simulations: { records: [], nextCursor: null },
			executionReceipts: { records: [], nextCursor: null },
		});
		await mount();
		await open();
		await vi.waitFor(() =>
			expect(host.textContent).toContain("No recorded simulations."),
		);
		expect(host.textContent).toContain(
			"Approval alone does not prove execution",
		);
		expect(button("Next predictions").disabled).toBe(true);
		expect(button("Next receipts").disabled).toBe(true);
	});
	it("preserves the other ledger cursor when either ledger advances or goes back", async () => {
		const simulationCursor = {
			timestamp: simulation.createdAt,
			id: simulation.id,
		};
		const receiptCursor = { timestamp: receipt.executedAt, id: receipt.id };
		api.getProvenance.mockImplementation(async (input) => {
			const result = provenance();
			result.simulations.nextCursor = input.simulations.cursor
				? null
				: simulationCursor;
			result.executionReceipts.nextCursor = input.executionReceipts.cursor
				? null
				: receiptCursor;
			return result;
		});
		await mount();
		await open();
		await vi.waitFor(() =>
			expect(button("Next predictions").disabled).toBe(false),
		);
		await act(async () => button("Next predictions").click());
		await vi.waitFor(() =>
			expect(api.getProvenance.mock.lastCall?.[0]).toMatchObject({
				simulations: { cursor: simulationCursor },
				executionReceipts: { cursor: undefined },
			}),
		);
		await vi.waitFor(() =>
			expect(button("Next receipts").disabled).toBe(false),
		);
		await act(async () => button("Next receipts").click());
		await vi.waitFor(() =>
			expect(api.getProvenance.mock.lastCall?.[0]).toMatchObject({
				simulations: { cursor: simulationCursor },
				executionReceipts: { cursor: receiptCursor },
			}),
		);
		await vi.waitFor(() =>
			expect(button("Previous predictions").disabled).toBe(false),
		);
		await act(async () => button("Previous predictions").click());
		await vi.waitFor(() =>
			expect(api.getProvenance.mock.lastCall?.[0]).toMatchObject({
				simulations: { cursor: undefined },
				executionReceipts: { cursor: receiptCursor },
			}),
		);
	});
	it("shows a read error and retries without claiming an empty history", async () => {
		api.getProvenance
			.mockRejectedValueOnce(new Error("read failed"))
			.mockResolvedValue(provenance());
		await mount();
		await open();
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Provenance unavailable"),
		);
		expect(host.textContent).not.toContain("No recorded simulations");
		await act(async () => button("Retry provenance").click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Simulated — not executed"),
		);
	});
});
