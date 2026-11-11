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
	AppRuntimeDraftProvider,
	useAppRuntimeDrafts,
} from "./app-runtime-draft-store";

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
				<AppRuntimeDraftProvider scope="test">
					<DraftFixture />
					<OfficeEditorUpgrade
						kind={kind}
						workspaceId="workspace"
						outputId="output"
						gadgetId="gadget"
						revisionId="pinned-app-revision"
					/>
				</AppRuntimeDraftProvider>
			</QueryClientProvider>,
		),
	);
const settle = () =>
	act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("automatic office editor upgrade", () => {
	it("waits while the old editor still holds unsaved changes", async () => {
		keepDraft = true;
		mount();
		await settle();
		expect(install).not.toHaveBeenCalled();
	});
	for (const kind of ["document", "sheet", "presentation"] as const) {
		it(`upgrades an open ${kind} editor once, by itself, and shows nothing`, async () => {
			install.mockResolvedValue({ gadget: { id: "gadget" } });
			const invalidate = vi
				.spyOn(client, "invalidateQueries")
				.mockResolvedValue();
			mount(kind);
			await settle();
			mount(kind);
			await settle();
			expect(install).toHaveBeenCalledTimes(1);
			expect(install).toHaveBeenCalledWith({
				workspaceId: "workspace",
				outputId: "output",
				kind,
				upgradeFromRevisionId: "pinned-app-revision",
			});
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.gadgets(),
			});
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.blueprints(),
			});
			expect(host.textContent).toBe("");
		});
	}
	it("compares editor versions separately from app revision numbers", () => {
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
		expect(
			officeEditorUpgrade(manifest(["readDocument", "replaceDocument"])),
		).toMatchObject({ kind: "document", version: 1, currentVersion: 13 });
		expect(
			officeEditorUpgrade(manifest(["readSheet", "replaceSheet"])),
		).toMatchObject({ kind: "sheet", version: 1, currentVersion: 12 });
		expect(
			officeEditorUpgrade(
				manifest(["readPresentation", "replacePresentation"]),
			),
		).toMatchObject({ kind: "presentation", version: 1, currentVersion: 9 });
		expect(
			officeEditorUpgrade(
				manifest(["readDocument", "replaceDocument"], { blueprintVersion: 13 }),
			),
		).toBeNull();
		expect(
			officeEditorUpgrade(
				manifest(["readSheet", "replaceSheet"], { blueprintVersion: 12 }),
			),
		).toBeNull();
		expect(officeEditorUpgrade(manifest(["customOperation"]))).toBeNull();
	});
	it("leaves the editor as it is when the upgrade is refused", async () => {
		install.mockRejectedValue(new Error("App revision changed"));
		mount();
		await settle();
		expect(install).toHaveBeenCalledTimes(1);
		expect(host.textContent).toBe("");
	});
});
