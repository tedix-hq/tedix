import { afterEach, expect, it, vi } from "vite-plus/test";
import { exportAppRuntimeOutput } from "./app-runtime-export";
const exportOutput = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({
	OS_API_URL: "https://api.example.test",
	osApi: { osWorkspaces: { outputs: { export: exportOutput } } },
}));
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
	"forwards workspace, saved revision and optional PDF header (%s)",
	async (revisionHeader) => {
		exportOutput.mockResolvedValue({
			url: "https://api.example.test/os-exports/output/rev-7.pdf",
			revision: 7,
			format: "pdf",
		});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
			() => undefined,
		);
		await exportAppRuntimeOutput({
			workspaceId: "workspace",
			outputId: "output",
			expectedRevision: 7,
			format: "pdf",
			...(revisionHeader ? { revisionHeader: true } : {}),
		});
		expect(exportOutput).toHaveBeenCalledWith({
			expectedWorkspaceId: "workspace",
			outputId: "output",
			expectedRevision: 7,
			format: "pdf",
			...(revisionHeader ? { revisionHeader: true } : {}),
		});
	},
);
