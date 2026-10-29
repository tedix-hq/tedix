import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";

const state = vi.hoisted(() => ({
	manifest: null as OsGadgetManifest | null,
	allowed: true,
}));
vi.mock("@/lib/os-query-options", () => ({
	canvasGadgetDetailQueryOptions: () => ({}),
	canvasOutputsQueryOptions: () => ({}),
	outputDetailQueryOptions: () => ({}),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: state.allowed
			? { currentRevision: { manifest: state.manifest } }
			: undefined,
	}),
	useQueries: () => [],
}));
import { WorkspaceAppCard } from "./workspace-app-cards";

function render() {
	return renderToStaticMarkup(
		<WorkspaceAppCard
			workspaceId="fictional-workspace"
			gadget={{
				id: "fictional-app",
				name: "Opportunity review",
				description: "Review suggested conversations",
			}}
			selected={false}
			onOpen={() => {}}
		/>,
	);
}

beforeEach(() => {
	state.allowed = true;
	state.manifest = {
		entry: "tedix:runtime/v1",
		capabilities: [],
		preview: {
			image: "data:image/png;base64,iVBORw0KGgo=",
			alt: "An opportunity card with review controls",
		},
	};
});

describe("Workspace app previews", () => {
	it("shows the saved screenshot without mounting or running the app", () => {
		const html = render();
		expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
		expect(html).toContain('alt="An opportunity card with review controls"');
		expect(html).toContain('loading="lazy"');
		expect(html).toContain("Open app");
		expect(html).not.toContain("<iframe");
	});

	it("keeps an app without a screenshot compact", () => {
		delete state.manifest!.preview;
		const html = render();
		expect(html).toContain("Review suggested conversations");
		expect(html).not.toContain('data-slot="output-grid-preview"');
	});

	it("does not show a saved screenshot when app detail access is unavailable", () => {
		state.allowed = false;
		const html = render();
		expect(html).not.toContain("data:image");
		expect(html).not.toContain('data-slot="output-grid-preview"');
	});
});
