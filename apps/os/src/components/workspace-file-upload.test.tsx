import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WORKSPACE_FILE_MAX_BYTES } from "@tedix/api-contract/schemas/workspace-files";
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

const resources = vi.hoisted(() => ({
	requestFileUpload: vi.fn(),
	confirmFileUpload: vi.fn(),
	list: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { resources, outputs: { list: vi.fn(), library: vi.fn() } },
	},
}));
import { WorkspaceFileUpload } from "./workspace-file-upload";
import {
	canvasOutputsQueryOptions,
	osQuery,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;
const onUploaded = vi.fn();

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick++)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function choose(file: File) {
	const input = container.querySelector("input")!;
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	act(() => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush();
}

beforeEach(() => {
	vi.clearAllMocks();
	resources.requestFileUpload.mockResolvedValue({
		resourceId: "file-1",
		partSize: 4,
		parts: [{ partNumber: 1, size: 4, url: "/upload-part" }],
	});
	resources.confirmFileUpload.mockResolvedValue({
		outputId: "output-1",
		resource: { name: "sample.txt" },
	});
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ partNumber: 1, etag: "part-etag" })),
			),
	);
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceFileUpload
					workspaceId={WORKSPACE_ID}
					onUploaded={onUploaded}
				/>
			</QueryClientProvider>,
		);
	});
});
afterEach(() => {
	act(() => root.unmount());
	client.clear();
	container.remove();
	vi.unstubAllGlobals();
});

describe("WorkspaceFileUpload", () => {
	it("accepts a file, confirms the upload and refreshes workspace and library readers", async () => {
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await choose(new File(["demo"], "sample.txt", { type: "text/plain" }));
		expect(resources.requestFileUpload).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			filename: "sample.txt",
			mimeType: "text/plain",
			size: 4,
		});
		expect(fetch).toHaveBeenCalledWith(
			"/upload-part",
			expect.objectContaining({ method: "PUT", credentials: "omit" }),
		);
		expect(resources.confirmFileUpload).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: "file-1",
			parts: [{ partNumber: 1, etag: "part-etag" }],
		});
		expect(onUploaded).toHaveBeenCalledWith({
			outputId: "output-1",
			name: "sample.txt",
			url: "/outputs/output-1",
		});
		for (const queryKey of [
			workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey,
			canvasOutputsQueryOptions(WORKSPACE_ID).queryKey,
			osQuery.osWorkspaces.outputs.library.key(),
		])
			expect(invalidate).toHaveBeenCalledWith({ queryKey });
		expect(container.querySelector("button")?.disabled).toBe(false);
	});
	it.each([0, WORKSPACE_FILE_MAX_BYTES + 1])(
		"rejects a file of %i bytes before requesting an upload",
		async (size) => {
			const file = new File(["demo"], "sample.txt");
			Object.defineProperty(file, "size", { value: size });
			await choose(file);
			expect(container.textContent).toContain(
				"Choose a file between 1 byte and 200 MiB.",
			);
			expect(resources.requestFileUpload).not.toHaveBeenCalled();
			expect(onUploaded).not.toHaveBeenCalled();
		},
	);
	it("shows an upload error and permits choosing the file again", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
		const file = new File(["demo"], "sample.txt");
		await choose(file);
		expect(container.textContent).toContain("Upload failed (503)");
		expect(resources.confirmFileUpload).not.toHaveBeenCalled();
		expect(onUploaded).not.toHaveBeenCalled();
		await choose(file);
		expect(container.textContent).not.toContain("Upload failed");
		expect(onUploaded).toHaveBeenCalledTimes(1);
	});
	it("compact: names the icon button and hands failures to the composer", async () => {
		const onError = vi.fn();
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<WorkspaceFileUpload
						compact
						workspaceId={WORKSPACE_ID}
						onUploaded={onUploaded}
						onError={onError}
					/>
				</QueryClientProvider>,
			);
		});
		const button = container.querySelector("button")!;
		expect(button.getAttribute("aria-label")).toBe("Upload file");
		expect(button.querySelector("svg")).not.toBeNull();
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
		await choose(new File(["demo"], "sample.txt"));
		expect(onError).toHaveBeenLastCalledWith(
			expect.stringContaining("Upload failed (503)"),
		);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).not.toContain("Upload failed");
		await choose(new File(["demo"], "sample.txt"));
		expect(onError).toHaveBeenLastCalledWith(null);
	});
	it("disables the control while uploading and ignores duplicate selection", async () => {
		let finish!: (value: unknown) => void;
		resources.requestFileUpload.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const file = new File(["demo"], "sample.txt");
		await choose(file);
		expect(container.querySelector("button")?.disabled).toBe(true);
		expect(container.textContent).toContain("Uploading 0%");
		await choose(file);
		expect(resources.requestFileUpload).toHaveBeenCalledTimes(1);
		finish({ resourceId: "file-1", partSize: 4, parts: [] });
		await flush();
		expect(container.querySelector("button")?.disabled).toBe(false);
	});
	const refreshedReaders = [
		{
			name: "workspace resources",
			queryKey: workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey,
		},
		{
			name: "canvas outputs",
			queryKey: canvasOutputsQueryOptions(WORKSPACE_ID).queryKey,
		},
		{
			name: "outputs library",
			queryKey: osQuery.osWorkspaces.outputs.library.key(),
		},
	];
	it.each(refreshedReaders)(
		"keeps the confirmed receipt when the $name refresh fails",
		async ({ queryKey }) => {
			const invalidate = vi.spyOn(client, "invalidateQueries");
			const rejected = JSON.stringify(queryKey);
			invalidate.mockImplementation((filters) =>
				JSON.stringify(filters?.queryKey) === rejected
					? Promise.reject(new Error("Refresh failed"))
					: Promise.resolve(),
			);
			await choose(new File(["demo"], "sample.txt", { type: "text/plain" }));
			expect(resources.confirmFileUpload).toHaveBeenCalledTimes(1);
			expect(onUploaded).toHaveBeenCalledTimes(1);
			expect(onUploaded).toHaveBeenCalledWith({
				outputId: "output-1",
				name: "sample.txt",
				url: "/outputs/output-1",
			});
			expect(container.textContent).not.toContain("failed");
			expect(container.querySelector("button")?.disabled).toBe(false);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 1_100));
			});
			await flush();
			const attempts = invalidate.mock.calls.filter(
				([filters]) => JSON.stringify(filters?.queryKey) === rejected,
			);
			expect(attempts.length).toBe(2);
			expect(resources.requestFileUpload).toHaveBeenCalledTimes(1);
		},
	);
	it("retries a failed reader reconciliation without re-uploading", async () => {
		const invalidate = vi.spyOn(client, "invalidateQueries");
		invalidate.mockRejectedValueOnce(new Error("Refresh failed"));
		await choose(new File(["demo"], "sample.txt"));
		expect(onUploaded).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(3);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_100));
		});
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(6);
		expect(resources.requestFileUpload).toHaveBeenCalledTimes(1);
		expect(resources.confirmFileUpload).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain("failed");
	});
	it("does not reconcile when the upload itself fails", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await choose(new File(["demo"], "sample.txt"));
		expect(container.textContent).toContain("Upload failed (503)");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_100));
		});
		expect(invalidate).not.toHaveBeenCalled();
	});
	it("fences deferred state when the workspace changes mid-upload", async () => {
		const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
		let confirm!: (value: unknown) => void;
		resources.confirmFileUpload.mockReturnValueOnce(
			new Promise((resolve) => {
				confirm = resolve;
			}),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		invalidate.mockRejectedValue(new Error("Refresh failed"));
		await choose(new File(["demo"], "sample.txt"));
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<WorkspaceFileUpload
						workspaceId={otherWorkspaceId}
						onUploaded={onUploaded}
					/>
				</QueryClientProvider>,
			);
		});
		confirm({ outputId: "output-1", resource: { name: "sample.txt" } });
		await flush();
		expect(onUploaded).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(container.textContent).not.toContain("failed");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_100));
		});
		expect(invalidate).not.toHaveBeenCalled();
	});
	it("drops progress reported for a previous workspace", async () => {
		const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
		let release!: (response: Response) => void;
		vi.mocked(fetch).mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		await choose(new File(["demo"], "sample.txt"));
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<WorkspaceFileUpload
						workspaceId={otherWorkspaceId}
						onUploaded={onUploaded}
					/>
				</QueryClientProvider>,
			);
		});
		release(new Response(JSON.stringify({ partNumber: 1, etag: "part-etag" })));
		await flush();
		expect(container.textContent).not.toContain("Uploading");
		expect(container.textContent).not.toContain("Saving");
		expect(onUploaded).not.toHaveBeenCalled();
	});
});
