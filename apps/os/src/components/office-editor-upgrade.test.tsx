import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	OfficeEditorUpgrade,
	officeEditorUpgrade,
} from "./office-editor-upgrade";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { osQueryKeys } from "@/lib/os-query-options";
import {
	DocWritingDraftProvider,
	useAppRuntimeDrafts,
} from "./doc-writing-drafts";

const install = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			gadgets: { installOutputEditor: install },
			blueprints: { get: vi.fn() },
		},
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
let client: QueryClient;
let keepDraft = false;
function DraftFixture() {
	const drafts = useAppRuntimeDrafts();
	if (keepDraft)
		drafts?.set("workspace:gadget:pinned-app-revision:output", {
			revision: 7,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Unsaved writing" }],
			},
		});
	return null;
}
beforeEach(() => {
	keepDraft = false;
	install.mockReset();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
	client.clear();
});

const mount = (kind: "document" | "sheet" | "presentation" = "document") =>
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<DocWritingDraftProvider scope="test">
					<DraftFixture />
					<OfficeEditorUpgrade
						kind={kind}
						workspaceId="workspace"
						outputId="output"
						gadgetId="gadget"
						revisionId="pinned-app-revision"
					/>
				</DocWritingDraftProvider>
			</QueryClientProvider>,
		),
	);
const click = (text: string) =>
	act(async () => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === text);
		expect(button).toBeDefined();
		button!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

describe("explicit office editor upgrade", () => {
	it("keeps a retained draft on the same app version until explicitly saved or discarded", async () => {
		keepDraft = true;
		mount();
		await click("Upgrade Doc editor");
		await click("Upgrade editor");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"Save or explicitly discard your current draft before upgrading",
			),
		);
		expect(install).not.toHaveBeenCalled();
	});
	it("never upgrades on load and requires review of what happens to unsaved edits", async () => {
		mount();
		expect(install).not.toHaveBeenCalled();
		await click("Upgrade Doc editor");
		expect(document.body.textContent).toContain(
			"keeping the same file, app and revision history",
		);
		expect(document.body.textContent).toContain(
			"Unsaved drafts stay attached to the old app version",
		);
		expect(install).not.toHaveBeenCalled();
	});
	for (const [kind, label] of [
		["sheet", "Sheet"],
		["presentation", "Slides"],
	] as const) {
		it(`requires explicit replacement of custom ${label} code and fences the current app revision`, async () => {
			install.mockResolvedValue({ gadget: { id: "gadget" } });
			mount(kind);
			expect(install).not.toHaveBeenCalled();
			await click(`Upgrade ${label} editor`);
			expect(document.body.textContent).toContain(
				"including custom code changes",
			);
			await click("Upgrade editor");
			await vi.waitFor(() =>
				expect(install).toHaveBeenCalledWith({
					workspaceId: "workspace",
					outputId: "output",
					kind,
					upgradeFromRevisionId: "pinned-app-revision",
				}),
			);
		});
	}
	it("compares editor bundle versions separately from app revision numbers, including legacy editors", () => {
		const manifest = (
			names: string[],
			settings: Record<string, string | number> = {},
		): OsGadgetManifest => ({
			entry: "tedix:runtime/v1",
			capabilities: [],
			config: { version: 1, settings },
			operations: names.map((name) => ({
				name,
				description: name,
				effect: "read",
				input: { type: "object", properties: {}, additionalProperties: false },
			})),
		});
		for (const version of [1, 2, 3])
			expect(
				officeEditorUpgrade(
					manifest(["readDocument", "replaceDocument"], {
						editor: `document-v${version}`,
					}),
				),
			).toMatchObject({ kind: "document", version, currentVersion: 7 });
		expect(
			officeEditorUpgrade(manifest(["readSheet", "replaceSheet"])),
		).toMatchObject({ kind: "sheet", version: 1, currentVersion: 6 });
		expect(
			officeEditorUpgrade(
				manifest(["readPresentation", "replacePresentation"]),
			),
		).toMatchObject({ kind: "presentation", version: 1, currentVersion: 6 });
		expect(
			officeEditorUpgrade(
				manifest(["readDocument", "replaceDocument"], { blueprintVersion: 7 }),
			),
		).toBeNull();
		expect(
			officeEditorUpgrade(
				manifest(["readSheet", "replaceSheet"], { blueprintVersion: 6 }),
			),
		).toBeNull();
		expect(officeEditorUpgrade(manifest(["customOperation"]))).toBeNull();
	});
	it("guards the app revision and refreshes generated gadget/code and blueprint keys", async () => {
		install.mockResolvedValue({ gadget: { id: "gadget" } });
		const invalidate = vi
			.spyOn(client, "invalidateQueries")
			.mockResolvedValue();
		mount();
		await click("Upgrade Doc editor");
		await click("Upgrade editor");
		await vi.waitFor(() =>
			expect(install).toHaveBeenCalledWith({
				workspaceId: "workspace",
				outputId: "output",
				kind: "document",
				upgradeFromRevisionId: "pinned-app-revision",
			}),
		);
		await vi.waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.gadgets(),
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.blueprints(),
		});
	});
	it("keeps a revision conflict visible for review without claiming the editor upgraded", async () => {
		install.mockRejectedValue(new Error("App revision changed"));
		mount();
		await click("Upgrade Doc editor");
		await click("Upgrade editor");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("App revision changed"),
		);
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	});
});
