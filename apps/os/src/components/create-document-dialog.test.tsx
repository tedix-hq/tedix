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
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";

const api = vi.hoisted(() => ({
	create: vi.fn(),
	list: vi.fn(),
	outputsList: vi.fn(),
	install: vi.fn(),
	gadgetsList: vi.fn(),
	resourcesList: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			outputs: { create: api.create, list: api.outputsList },
			workspaces: { list: api.list },
			gadgets: { installOutputEditor: api.install, list: api.gadgetsList },
			resources: { list: api.resourcesList },
			blueprints: { list: vi.fn() },
		},
	},
}));
import { canvasOutputsQueryOptions } from "@/lib/os-query-options";
import { NewResourceMenu } from "./create-document-dialog";
import {
	documentFromTemplate,
	documentTemplates,
} from "@/lib/document-templates";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cleanups: Array<() => void> = [];
function renderButton(workspaceId?: string) {
	const onCreated = vi.fn();
	const onAppCreated = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<NewResourceMenu
					workspaceId={workspaceId}
					onCreated={onCreated}
					onAppCreated={onAppCreated}
				/>
			</QueryClientProvider>,
		),
	);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
		client.clear();
	});
	return { onCreated, onAppCreated, invalidate, client };
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function click(label: string) {
	const button = [
		...document.querySelectorAll<HTMLElement>("button, [role=menuitem]"),
	].find((item) => item.textContent?.trim() === label);
	if (!button) throw new Error(`Missing ${label}`);
	act(() => button.click());
}
function submit() {
	const form = document.querySelector("form")!;
	act(() =>
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		),
	);
}
beforeEach(() => {
	api.create.mockReset();
	api.install.mockReset();
	api.list.mockReset();
	api.list.mockResolvedValue({ items: [] });
});
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

describe("document creation", () => {
	for (const [label, kind] of [
		["Doc", "document"],
		["Sheet", "sheet"],
		["Slides", "presentation"],
	] as const) {
		it(`creates ${label} through the shared installer and opens the returned gadget`, async () => {
			const output = { id: `file-${kind}`, workspaceId: WORKSPACE_ID };
			const gadget = { id: `editor-${kind}`, workspaceId: WORKSPACE_ID };
			api.create.mockResolvedValue({ output });
			api.install.mockResolvedValue({ gadget });
			const { onCreated, onAppCreated } = renderButton(WORKSPACE_ID);
			click("New");
			await flush();
			click(label);
			await flush();
			click(`Create ${label}`);
			await flush();
			expect(api.create.mock.calls[0]![0]).toMatchObject({
				workspaceId: WORKSPACE_ID,
				kind,
				content: { kind },
			});
			expect(
				OsOutputContentSchema.safeParse(api.create.mock.calls[0]![0].content)
					.success,
			).toBe(true);
			expect(api.install).toHaveBeenCalledWith(
				{ workspaceId: WORKSPACE_ID, outputId: output.id, kind },
				expect.anything(),
			);
			expect(onAppCreated).toHaveBeenCalledWith(gadget);
			expect(onCreated).not.toHaveBeenCalled();
		});
	}
	it("retries gadget installation against the same file without creating another body", async () => {
		const output = { id: "retained-file", workspaceId: WORKSPACE_ID };
		const gadget = { id: "retained-gadget", workspaceId: WORKSPACE_ID };
		api.create.mockResolvedValue({ output });
		api.install
			.mockRejectedValueOnce(new Error("Install temporarily unavailable"))
			.mockResolvedValueOnce({ gadget });
		const { onAppCreated } = renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		click("Doc");
		await flush();
		click("Create Doc");
		await flush();
		expect(document.body.textContent).toContain("Your file was created");
		expect(onAppCreated).not.toHaveBeenCalled();
		click("Retry app installation");
		await flush();
		expect(api.create).toHaveBeenCalledTimes(1);
		expect(api.install.mock.calls.map((call) => call[0].outputId)).toEqual([
			output.id,
			output.id,
		]);
		expect(onAppCreated).toHaveBeenCalledWith(gadget);
	});
	it("offers the created file read-only after installing its editor fails", async () => {
		const output = { id: "retained-file", workspaceId: WORKSPACE_ID };
		api.create.mockResolvedValue({ output });
		api.install.mockRejectedValue(new Error("Unavailable"));
		const { onCreated, onAppCreated } = renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		click("Doc");
		await flush();
		click("Create Doc");
		await flush();
		expect(onCreated).not.toHaveBeenCalled();
		click("Open file read-only");
		expect(onCreated).toHaveBeenCalledWith(output);
		expect(onAppCreated).not.toHaveBeenCalled();
	});
	it("chooses the available workspace for gadget creation from the global Files page", async () => {
		api.list.mockResolvedValue({
			items: [{ id: WORKSPACE_ID, name: "Project" }],
		});
		const output = { id: "global-file", workspaceId: WORKSPACE_ID },
			gadget = { id: "global-gadget", workspaceId: WORKSPACE_ID };
		api.create.mockResolvedValue({ output });
		api.install.mockResolvedValue({ gadget });
		const { onAppCreated } = renderButton();
		click("New");
		await flush();
		click("Sheet");
		await flush();
		expect(document.body.textContent).toContain("Project");
		click("Create Sheet");
		await flush();
		expect(api.create.mock.calls[0]![0].workspaceId).toBe(WORKSPACE_ID);
		expect(onAppCreated).toHaveBeenCalledWith(gadget);
	});

	it("creates a blank document in the current workspace and opens only the returned output", async () => {
		const output = { id: "new-output", workspaceId: WORKSPACE_ID };
		api.create.mockResolvedValue({ output, revision: {} });
		const { onCreated, invalidate } = renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		click("Document from a template");
		await flush();
		submit();
		await flush();
		expect(api.create).toHaveBeenCalledWith(
			{
				kind: "document",
				title: "Untitled document",
				workspaceId: WORKSPACE_ID,
				content: { kind: "document", blocks: [] },
			},
			expect.anything(),
		);
		expect(onCreated).toHaveBeenCalledWith(output);
		expect(invalidate).toHaveBeenCalled();
		expect(document.querySelector("form")).toBeNull();
		expect(api.list).not.toHaveBeenCalled();
	});
	it("reconciles the cached workspace list before navigation while refetch is pending", async () => {
		const output = {
			id: "new-output",
			workspaceId: WORKSPACE_ID,
			organizationId: "org",
			kind: "document" as const,
			title: "New document",
			status: "active" as const,
			currentRevisionId: "revision",
			createdByKind: "user" as const,
			createdById: "user",
			createdAt: "2026-09-22T12:00:00.000Z",
			updatedAt: "2026-09-22T12:00:00.000Z",
		};
		const existing = { ...output, id: "existing-output" };
		const other = {
			...output,
			id: "another-workspace-output",
			workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		};
		api.create.mockResolvedValue({ output, revision: {} });
		const { onCreated, invalidate, client } = renderButton(WORKSPACE_ID);
		const key = canvasOutputsQueryOptions(WORKSPACE_ID).queryKey;
		const otherKey = canvasOutputsQueryOptions(
			"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		).queryKey;
		client.setQueryData(key, {
			items: [existing],
			truncated: true,
		});
		client.setQueryData(otherKey, {
			items: [other],
			truncated: false,
		});
		invalidate.mockImplementation(() => new Promise(() => {}));
		onCreated.mockImplementation(() => {
			expect(client.getQueryData(key)).toEqual({
				items: [output, existing],
				truncated: true,
			});
		});
		click("New");
		await flush();
		click("Document from a template");
		await flush();
		submit();
		await flush();
		expect(onCreated).toHaveBeenCalledWith(output);
		expect(client.getQueryData(otherKey)).toEqual({
			items: [other],
			truncated: false,
		});
	});

	it("creates the selected close plan with the entered title", async () => {
		api.create.mockResolvedValue({
			output: { id: "plan", workspaceId: WORKSPACE_ID },
			revision: {},
		});
		renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		click("Document from a template");
		await flush();
		const input = document.querySelector<HTMLInputElement>(
			"#new-document-title",
		)!;
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "  September close  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() =>
			document
				.querySelector<HTMLButtonElement>("#new-document-template")!
				.click(),
		);
		await flush();
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((item) => item.textContent === "Accountancy close plan")!;
		act(() => option.click());
		await flush();
		submit();
		await flush();
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			kind: "document",
			title: "September close",
			workspaceId: WORKSPACE_ID,
			content: documentFromTemplate("close-plan", "September close"),
		});
	});
	it("keeps the creation form and error available when creation fails", async () => {
		api.create.mockRejectedValue(new Error("Workspace is archived"));
		const { onCreated } = renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		click("Document from a template");
		await flush();
		submit();
		await flush();
		expect(document.body.textContent).toContain("Workspace is archived");
		expect(document.querySelector("form")).not.toBeNull();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it("allows an organization document when workspace discovery fails", async () => {
		api.list.mockRejectedValue(new Error("Offline"));
		api.create.mockResolvedValue({
			output: { id: "new-output", workspaceId: null },
			revision: {},
		});
		renderButton();
		click("New");
		await flush();
		click("Document from a template");
		await flush();
		expect(document.body.textContent).toContain(
			"Workspaces could not be loaded",
		);
		submit();
		await flush();
		expect(api.create.mock.calls[0]?.[0]).not.toHaveProperty("workspaceId");
	});
	it("seeds editable canonical content for every template without asserting a close", () => {
		for (const template of documentTemplates) {
			const content = documentFromTemplate(template.id, "September review");
			expect(OsOutputContentSchema.safeParse(content).success).toBe(true);
			if (content.kind !== "document" || template.id === "blank") continue;
			expect(content.blocks[0]).toEqual({
				type: "heading",
				level: 1,
				text: "September review",
			});
			expect(JSON.stringify(content)).toContain("[");
		}
		expect(
			JSON.stringify(documentFromTemplate("monthly-close", "September")),
		).toContain("Status: not assessed");
	});
	it("offers the Doc, Sheet and Slides gadgets and a document template", async () => {
		renderButton(WORKSPACE_ID);
		click("New");
		await flush();
		expect(
			[...document.querySelectorAll('[role="menuitem"]')].map((item) =>
				item.textContent?.trim(),
			),
		).toEqual([
			"Doc",
			"Sheet",
			"Slides",
			"Browse templates",
			"Document from a template",
		]);
		expect(
			document.querySelector('a[role="menuitem"]')?.getAttribute("href"),
		).toBe("/blueprints");
	});
});
