import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { OfficeFileContent } from "@tedix/api-contract/utils/office-file-read";
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import { OfficeFilePreview } from "./office-file-preview";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	install: vi.fn(),
	read: vi.fn(),
}));
vi.mock("@tedix/api-contract/utils/office-file-read", async (original) => {
	const actual =
		await original<
			typeof import("@tedix/api-contract/utils/office-file-read")
		>();
	mocks.read.mockImplementation(actual.readOfficeFile);
	return { ...actual, readOfficeFile: mocks.read };
});
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		osWorkspaces: {
			outputs: {
				create: { mutationOptions: () => ({ mutationFn: mocks.create }) },
			},
			gadgets: {
				installOutputEditor: {
					mutationOptions: () => ({ mutationFn: mocks.install }),
				},
			},
		},
	},
	osQueryKeys: {
		outputs: () => ["office-preview-test-outputs"],
		gadgets: () => ["office-preview-test-gadgets"],
	},
	workspaceResourcesQueryOptions: (workspaceId: string) => ({
		queryKey: ["office-preview-test-resources", workspaceId],
	}),
}));

const W = "10000000-0000-4000-8000-000000000001";
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = null;
	vi.unstubAllGlobals();
	mocks.create.mockReset();
	mocks.install.mockReset();
});

async function render(
	filename: string,
	format: "csv" | "xlsx" | "docx" | "pptx",
	bytes: string,
	openEditor = vi.fn(),
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new TextEncoder().encode(bytes))),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={new QueryClient()}>
				<ChatOutputLinkContext.Provider value={{ openEditor }}>
					<OfficeFilePreview
						workspaceId={W}
						resourceId="10000000-0000-4000-8000-000000000002"
						url="/api/workspace-files/file?sig=1"
						filename={filename}
						format={format}
					/>
				</ChatOutputLinkContext.Provider>
			</QueryClientProvider>,
		),
	);
	await vi.waitFor(() =>
		expect(host!.textContent).not.toContain("Reading file"),
	);
	return host;
}

it("shows a CSV as a table and makes an editable sheet that opens in its editor", async () => {
	const openEditor = vi.fn();
	const view = await render(
		"Supplies.csv",
		"csv",
		"Item,Price\nPaper,3.5\nInk,10\n",
		openEditor,
	);
	const headers = [...view.querySelectorAll("thead th")].map(
		(cell) => cell.textContent,
	);
	expect(headers).toEqual(["Row", "A", "B"]);
	const rows = [...view.querySelectorAll("tbody tr")].map((row) =>
		[...row.children].map((cell) => cell.textContent),
	);
	expect(rows).toEqual([
		["1", "Item", "Price"],
		["2", "Paper", "3.5"],
		["3", "Ink", "10"],
	]);
	mocks.create.mockResolvedValue({ output: { id: "copy-1" } });
	mocks.install.mockResolvedValue({ gadget: { id: "gadget-1" } });
	const button = [...view.querySelectorAll("button")].find(
		(item) => item.textContent === "Make an editable copy",
	)!;
	await act(async () => button.click());
	await vi.waitFor(() => expect(openEditor).toHaveBeenCalledWith("gadget-1"));
	const input = mocks.create.mock.calls[0]![0];
	expect(input).toMatchObject({
		kind: "sheet",
		title: "Supplies",
		workspaceId: W,
		content: {
			kind: "sheet",
			columns: ["A", "B"],
			rows: [
				["Item", "Price"],
				["Paper", 3.5],
				["Ink", 10],
			],
		},
	});
	expect(mocks.install.mock.calls[0]![0]).toEqual({
		workspaceId: W,
		outputId: "copy-1",
		kind: "sheet",
	});
	expect(view.textContent).toContain(
		"Saved as a Tedix sheet in this workspace.",
	);
});

it("switches between the sheets of a workbook", async () => {
	mocks.read.mockResolvedValueOnce({
		kind: "sheet",
		format: "xlsx",
		truncated: false,
		sheets: [
			{ name: "Budget", rows: [["Paper", 3.5]], formulas: [] },
			{ name: "Notes", rows: [["Order more"]], formulas: [] },
		],
	} satisfies OfficeFileContent);
	const view = await render("Book.xlsx", "xlsx", "zip");
	expect(view.querySelector("tbody")?.textContent).toContain("Paper");
	const tab = [...view.querySelectorAll('[role="tab"]')].find(
		(item) => item.textContent === "Notes",
	) as HTMLElement;
	await act(async () => tab.click());
	expect(view.querySelector("tbody")?.textContent).toContain("Order more");
});

it("shows a Word document's headings, paragraphs and tables", async () => {
	mocks.read.mockResolvedValueOnce({
		kind: "document",
		format: "docx",
		truncated: false,
		blocks: [
			{ type: "heading", level: 1, text: "Plan" },
			{ type: "paragraph", text: "Hello world" },
			{
				type: "table",
				rows: [
					["Name", "Role"],
					["Ada", "Lead"],
				],
			},
		],
	} satisfies OfficeFileContent);
	const view = await render("Plan.docx", "docx", "zip");
	expect(view.querySelector("h2")?.textContent).toBe("Plan");
	expect(view.querySelector("p")?.textContent).toBe("Hello world");
	expect(view.querySelectorAll("tbody tr")).toHaveLength(2);
	expect(view.textContent).toContain("Saves a Tedix doc you can edit.");
});

it("lists a deck's slides with their text and notes", async () => {
	mocks.read.mockResolvedValueOnce({
		kind: "slides",
		format: "pptx",
		truncated: false,
		slides: [
			{ title: "Welcome", text: ["Agenda", "Goals"], notes: "Say hello" },
			{ title: "", text: [] },
		],
	} satisfies OfficeFileContent);
	const view = await render("Deck.pptx", "pptx", "zip");
	const slides = view.querySelectorAll('ol[aria-label="Slides"] > li');
	expect(slides).toHaveLength(2);
	expect(slides[0]!.textContent).toContain("Slide 1");
	expect(slides[0]!.textContent).toContain("Agenda");
	expect(slides[0]!.textContent).toContain("Speaker notes: Say hello");
	expect(slides[1]!.textContent).toContain("Untitled slide");
});

it("says when a file cannot be read", async () => {
	const view = await render("broken.xlsx", "xlsx", "not a zip");
	expect(view.textContent).toContain("Download it to open it.");
});
