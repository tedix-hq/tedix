import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
const source = readFileSync(
	new URL(
		"../../../../examples/work-board-hygiene/workflow.js",
		import.meta.url,
	),
	"utf8",
);
const { workflow, pairs } = new Function(
	source
		.replace(
			"export function consolidationPairs",
			"function consolidationPairs",
		)
		.replace("export default", "const workflow =") +
		"; return {workflow, pairs:consolidationPairs};",
)();
const stub = {
	id: "stub",
	projectId: "fictional-project",
	title: "Investigate old stub",
	version: 1,
	createdAt: "2020-01-01T00:00:00Z",
	description: null,
};
function fixture(probe = false, readOnlyProjectIds: string[] = []) {
	const cancel = vi.fn().mockResolvedValue({ disposition: "cancelled" });
	const env = {
		MCP: {
			tedi: {
				work_items_list: vi.fn(async (input: { disposition: string }) =>
					input.disposition === "proposed" ? [stub] : [],
				),
				work_item_get: vi
					.fn()
					.mockResolvedValue({ workItem: stub, comments: [], evidence: [] }),
				list_work_attempts: vi.fn().mockResolvedValue({ data: [] }),
				cancel_work_item: cancel,
				work_item_comment: vi.fn(),
			},
			work: {
				list_relations: vi
					.fn()
					.mockResolvedValue({ relations: [], truncated: false }),
			},
			os: {
				get_os_output: vi.fn().mockResolvedValue({
					currentRevision: { revision: 1, content: { blocks: [] } },
				}),
				patch_os_document: vi.fn(),
			},
		},
	};
	const config = {
		projectIds: ["fictional-project"],
		staleDays: 21,
		outputId: "digest",
		healthWorkItemId: "health",
		probe,
		readOnlyProjectIds,
	};
	const step = {
		do: async (_name: string, fn: () => Promise<unknown>) => fn(),
	};
	return {
		env,
		cancel,
		config,
		run: () => workflow.run({ payload: config }, step, env),
	};
}
describe("daily board hygiene workflow", () => {
	it("detects shared evidence and preserves checklists across proposed merges", () => {
		const items = [
			{
				id: "a",
				projectId: "one",
				title: "Review supplier invoice",
				description: "- [ ] Check totals https://example.test/source",
			},
			{
				id: "b",
				projectId: "one",
				title: "Review supplier invoices",
				description: "- [ ] Check totals https://example.test/source",
			},
			{ id: "c", projectId: "two", title: "Review supplier invoice" },
		];
		expect(pairs(items, 0.75)).toHaveLength(1);
		expect(pairs(items, 0.75)[0].reason).toContain("Preserve both checklists");
	});
	it("closes an untouched stub and publishes a digest", async () => {
		const f = fixture();
		const result = await f.run();
		expect(result.closed).toEqual(["stub"]);
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(f.env.MCP.os.patch_os_document).toHaveBeenCalledOnce();
	});
	it("probe performs no writes", async () => {
		const f = fixture(true);
		await f.run();
		expect(f.cancel).not.toHaveBeenCalled();
		expect(f.env.MCP.os.patch_os_document).not.toHaveBeenCalled();
	});
	it("preserves Attempts, comments, evidence and dependencies", async () => {
		for (const field of ["attempt", "comment", "evidence", "dependency"]) {
			const f = fixture();
			if (field === "attempt")
				f.env.MCP.tedi.list_work_attempts.mockResolvedValue({
					data: [{ id: "expired-proof" }],
				});
			if (field === "comment")
				f.env.MCP.tedi.work_item_get.mockResolvedValue({
					workItem: stub,
					comments: [{ body: "owner activity" }],
					evidence: [],
				});
			if (field === "evidence")
				f.env.MCP.tedi.work_item_get.mockResolvedValue({
					workItem: stub,
					comments: [],
					evidence: [{ uri: "proof" }],
				});
			if (field === "dependency")
				f.env.MCP.work.list_relations.mockResolvedValue({
					relations: [{ fromWorkItemId: "stub", toWorkItemId: "dependent" }],
					truncated: false,
				});
			await f.run();
			expect(f.cancel).not.toHaveBeenCalled();
		}
	});
});

it("preserves legacy acceptance criteria returned by the fresh detail read", async () => {
	const f = fixture();
	f.env.MCP.tedi.work_item_get.mockResolvedValue({
		workItem: {
			...stub,
			acceptanceContract: {
				version: 1,
				claims: [{ claim: "An existing promised outcome" }],
			},
		},
		comments: [],
		evidence: [],
	});
	await f.run();
	expect(f.cancel).not.toHaveBeenCalled();
});

it("reports on protected projects without cancelling their stubs", async () => {
	const f = fixture(false, [stub.projectId]);
	await f.run();
	expect(f.cancel).not.toHaveBeenCalled();
});

it("scans large portfolios without per-project calls and preserves scope", async () => {
	const f = fixture(true);
	f.config.projectIds = [
		stub.projectId,
		...Array.from({ length: 82 }, (_, i) => `fictional-${i}`),
	];
	f.env.MCP.tedi.work_items_list.mockImplementation(async (input) =>
		input.disposition === "proposed"
			? [stub, { ...stub, id: "unselected", projectId: "outside-scope" }]
			: [],
	);
	const result = await f.run();
	expect(result.reviewed).toBe(1);
	expect(f.env.MCP.tedi.work_items_list).toHaveBeenCalledTimes(2);
	expect(
		f.env.MCP.tedi.work_items_list.mock.calls.every(
			([input]) => !("projectId" in input),
		),
	).toBe(true);
	expect(f.cancel).not.toHaveBeenCalled();
});

it("stops an oversized scan before any writes", async () => {
	const f = fixture();
	f.env.MCP.tedi.work_items_list.mockResolvedValue(
		Array.from({ length: 100 }, (_, i) => ({ ...stub, id: `stub-${i}` })),
	);
	await expect(f.run()).rejects.toThrow("1000-item scan limit");
	expect(f.cancel).not.toHaveBeenCalled();
	expect(f.env.MCP.os.patch_os_document).not.toHaveBeenCalled();
});
