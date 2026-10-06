import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const inspection = vi.hoisted(() => ({
	status: vi.fn(),
	file: vi.fn(),
	authority: {
		role: "owner" as string | null,
		permissions: ["secrets:manage"] as string[],
	},
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: inspection.authority },
	}),
}));
vi.mock("@/lib/api", () => ({
	osApi: { workItems: { inspectAttemptRepository: inspection.file } },
}));
vi.mock("@/lib/os-query-options", () => ({
	workstationInspectionStatusQueryOptions: () => ({
		queryKey: ["workstation-inspection-test"],
		queryFn: inspection.status,
	}),
}));
import {
	decodeWorkstationInspectionText,
	decodeWorkstationInventory,
	sameInspectionProvenance,
	WorkstationInspectionPanel,
} from "./workstation-inspection-panel";

const base64 = (value: Uint8Array | string) =>
	(value instanceof Uint8Array
		? Buffer.from(value)
		: Buffer.from(value, "utf8")
	).toString("base64");

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	host = undefined;
	client?.clear();
	client = undefined;
	vi.clearAllMocks();
	inspection.authority.role = "owner";
	inspection.authority.permissions = ["secrets:manage"];
});

async function mountPanel() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client!}>
				<WorkstationInspectionPanel
					workItemId="00000000-0000-4000-8000-000000000001"
					attemptId="00000000-0000-4000-8000-000000000002"
				/>
			</QueryClientProvider>,
		),
	);
	return host;
}

function clickButton(label: string) {
	const button = [...(host?.querySelectorAll("button") ?? [])].find((node) =>
		node.textContent?.includes(label),
	);
	if (!button) throw new Error(`Missing ${label}`);
	return act(async () => button.click());
}

describe("workstation inspection inventory", () => {
	it.each([
		["member", ["secrets:manage"]],
		["admin", []],
		[null, ["secrets:manage"]],
	])(
		"hides raw Changes without complete caller authority",
		async (role, permissions) => {
			inspection.authority.role = role;
			inspection.authority.permissions = permissions;
			await mountPanel();
			expect(host?.textContent).toContain("Raw changes require owner or admin");
			expect(host?.querySelector("button")).toBeNull();
			expect(inspection.status).not.toHaveBeenCalled();
			expect(inspection.file).not.toHaveBeenCalled();
		},
	);

	it("accepts the typed tracked and untracked inventory", () => {
		expect(
			decodeWorkstationInventory({
				files: [
					{
						status: "modified",
						rawStatus: "M",
						path: "src/a.ts",
						untracked: false,
					},
					{
						status: "untracked",
						rawStatus: "?",
						path: "new file.ts",
						untracked: true,
					},
				],
			}),
		).toEqual([
			{
				status: "modified",
				rawStatus: "M",
				path: "src/a.ts",
				untracked: false,
			},
			{
				status: "untracked",
				rawStatus: "?",
				path: "new file.ts",
				untracked: true,
			},
		]);
	});

	it("fails closed when a typed inventory is absent", () => {
		expect(decodeWorkstationInventory({})).toBeNull();
	});

	it("decodes file bytes without treating embedded NULs as inventory framing", () => {
		expect(decodeWorkstationInspectionText(base64("a\0b"))).toBe("a\0b");
		expect(
			decodeWorkstationInspectionText(base64(new Uint8Array([0xff]))),
		).toBeNull();
	});

	it("rejects file views from another baseline, generation, or earlier inventory", () => {
		const inventory = {
			baselineSha: "a".repeat(40),
			currentSha: "c".repeat(40),
			generationId: "generation-2",
			observedAt: "2026-09-23T12:00:00.000Z",
		};
		expect(
			sameInspectionProvenance(inventory, {
				...inventory,
				observedAt: "2026-09-23T12:00:01.000Z",
			}),
		).toBe(true);
		expect(
			sameInspectionProvenance(inventory, {
				...inventory,
				baselineSha: "b".repeat(40),
			}),
		).toBe(false);
		expect(
			sameInspectionProvenance(inventory, {
				...inventory,
				currentSha: "d".repeat(40),
			}),
		).toBe(false);
		expect(
			sameInspectionProvenance(inventory, {
				...inventory,
				generationId: "generation-1",
			}),
		).toBe(false);
		expect(
			sameInspectionProvenance(inventory, {
				...inventory,
				observedAt: "2026-09-23T11:59:59.999Z",
			}),
		).toBe(false);
	});
});

describe("workstation review surface", () => {
	const provenance = {
		baselineSha: "a".repeat(40),
		currentSha: "c".repeat(40),
		generationId: "generation-2",
		observedAt: "2026-09-23T12:00:00.000Z",
	};
	it("shows provenance and rejects a file response older than refreshed inventory", async () => {
		inspection.status
			.mockResolvedValueOnce({
				...provenance,
				files: [
					{
						status: "modified",
						rawStatus: "M",
						path: "src/a.ts",
						untracked: false,
					},
				],
				timedOut: false,
				truncated: false,
				truncationReasons: [],
			})
			.mockResolvedValueOnce({
				...provenance,
				observedAt: "2026-09-23T12:01:00.000Z",
				files: [
					{
						status: "modified",
						rawStatus: "M",
						path: "src/a.ts",
						untracked: false,
					},
				],
				timedOut: false,
				truncated: false,
				truncationReasons: [],
			});
		inspection.file.mockResolvedValue({
			...provenance,
			kind: "git",
			dataBase64: base64("old diff"),
			stderrBase64: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
			truncationReasons: [],
			binary: false,
			hunks: [
				{
					header: "@@ -1 +1 @@",
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					lines: [
						{
							kind: "addition",
							content: "structured-new",
							oldLine: null,
							newLine: 1,
						},
					],
				},
			],
		});
		const view = await mountPanel();
		await clickButton("Changes");
		await vi.waitFor(() => expect(view.textContent).toContain("generation-2"));
		expect(view.textContent).toContain("non-atomic snapshot");
		await clickButton("Modified · src/a.ts");
		await vi.waitFor(() => expect(view.textContent).toContain("old diff"));
		expect(view.textContent).toContain("structured-new");
		await clickButton("Refresh changes");
		await vi.waitFor(() => expect(inspection.status).toHaveBeenCalledTimes(2));
		await clickButton("Modified · src/a.ts");
		await vi.waitFor(() =>
			expect(view.textContent).toContain("File view is stale"),
		);
		expect(view.textContent).not.toContain("old diff");
	});

	it("does not describe a truncated empty inventory as no changes", async () => {
		inspection.status.mockResolvedValue({
			...provenance,
			files: [],
			timedOut: false,
			truncated: true,
			truncationReasons: ["entry_limit"],
		});
		const view = await mountPanel();
		await clickButton("Changes");
		await vi.waitFor(() =>
			expect(view.textContent).toContain("Inventory incomplete"),
		);
		expect(view.textContent).not.toContain("No working tree changes");
	});
});
