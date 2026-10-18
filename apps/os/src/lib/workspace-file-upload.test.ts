import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { WORKSPACE_FILE_PART_BYTES } from "@tedix/api-contract/schemas/workspace-files";
const api = vi.hoisted(() => ({
	requestFileUpload: vi.fn(),
	confirmFileUpload: vi.fn(),
}));
vi.mock("./api", () => ({ osApi: { osWorkspaces: { resources: api } } }));
import { uploadWorkspaceFile } from "./workspace-file-upload";
afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});
describe("workspace file upload", () => {
	it("uploads binary slices and confirms their receipts without encoding the file", async () => {
		const size = WORKSPACE_FILE_PART_BYTES + 3;
		const file = new File([new Uint8Array(size)], "demo.webm", {
			type: "video/webm",
		});
		api.requestFileUpload.mockResolvedValue({
			resourceId: "file-1",
			partSize: WORKSPACE_FILE_PART_BYTES,
			parts: [
				{
					partNumber: 1,
					size: WORKSPACE_FILE_PART_BYTES,
					url: "https://upload.example.test/1",
				},
				{ partNumber: 2, size: 3, url: "https://upload.example.test/2" },
			],
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ partNumber: 1, etag: "a" }))
			.mockResolvedValueOnce(Response.json({ partNumber: 2, etag: "b" }));
		vi.stubGlobal("fetch", fetch);
		api.confirmFileUpload.mockResolvedValue({ outputId: "output-1" });
		const progress = vi.fn();
		await uploadWorkspaceFile("workspace-1", file, progress);
		expect(api.requestFileUpload).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			filename: "demo.webm",
			mimeType: "video/webm",
			size,
		});
		expect(fetch.mock.calls[0]?.[1].body).toBeInstanceOf(Blob);
		expect(fetch.mock.calls[0]?.[1].body.size).toBe(WORKSPACE_FILE_PART_BYTES);
		expect(fetch.mock.calls[1]?.[1].body.size).toBe(3);
		expect(api.confirmFileUpload).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			resourceId: "file-1",
			parts: [
				{ partNumber: 1, etag: "a" },
				{ partNumber: 2, etag: "b" },
			],
		});
		expect(progress).toHaveBeenLastCalledWith(100);
	});
	it("leaves a failed upload unconfirmed", async () => {
		api.requestFileUpload.mockResolvedValue({
			resourceId: "file-1",
			partSize: WORKSPACE_FILE_PART_BYTES,
			parts: [{ partNumber: 1, size: 1, url: "https://upload.example.test/1" }],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);
		await expect(
			uploadWorkspaceFile(
				"workspace-1",
				new File(["x"], "test.pdf", { type: "application/pdf" }),
			),
		).rejects.toThrow("403");
		expect(api.confirmFileUpload).not.toHaveBeenCalled();
	});
});
