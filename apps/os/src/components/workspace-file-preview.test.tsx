import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ mimeType: "video/mp4", isError: false }));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		osWorkspaces: { resources: { getFile: { queryOptions: () => ({}) } } },
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		isPending: false,
		isError: state.isError,
		data: {
			filename: "Fictional demo",
			mimeType: state.mimeType,
			size: 123,
			url: "/api/workspace-files/fictional/media?sig=test",
		},
	}),
}));
import { WorkspaceFilePreview } from "./workspace-file-preview";
function render() {
	return renderToStaticMarkup(
		<WorkspaceFilePreview
			workspaceId="fictional-workspace"
			resourceId="fictional-resource"
		/>,
	);
}
describe("workspace file preview", () => {
	it.each(["video/mp4", "video/webm"])(
		"renders native video controls for %s",
		(mime) => {
			state.mimeType = mime;
			state.isError = false;
			expect(render()).toContain("<video");
			expect(render()).toContain('controls=""');
		},
	);
	it("renders PDFs and images inline", () => {
		state.mimeType = "application/pdf";
		expect(render()).toContain("<iframe");
		state.mimeType = "image/png";
		expect(render()).toContain("<img");
	});
	it("offers arbitrary files as downloads and displays revoked access", () => {
		state.mimeType = "text/html";
		expect(render()).not.toContain("<iframe");
		const container = document.createElement("div");
		container.innerHTML = render();
		const download = container.querySelector('a[download="Fictional demo"]');
		expect(download?.textContent).toBe("Download file");
		expect(download?.getAttribute("role")).not.toBe("button");
		expect(download?.getAttribute("href")).toBe(
			"/api/workspace-files/fictional/media?sig=test",
		);
		state.isError = true;
		expect(render()).toContain("no longer have access");
	});
});
