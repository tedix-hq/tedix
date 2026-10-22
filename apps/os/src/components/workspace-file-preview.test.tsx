import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
	file: {
		filename: "Fictional demo",
		mimeType: "video/mp4",
		size: 123,
		url: "/api/workspace-files/fictional/media?sig=1",
	} as {
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	} | null,
	isPending: false,
	isError: false,
	isFetching: false,
	refetch: vi.fn(),
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		osWorkspaces: { resources: { getFile: { queryOptions: () => ({}) } } },
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		isPending: state.isPending,
		isError: state.isError,
		isFetching: state.isFetching,
		data: state.isPending || state.isError ? undefined : state.file,
		refetch: state.refetch,
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

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: Root | undefined;
async function show(
	file: NonNullable<typeof state.file>,
	resourceId = "fictional-resource",
) {
	state.isPending = false;
	state.isError = false;
	state.file = file;
	if (!host) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () =>
		root!.render(
			<WorkspaceFilePreview
				workspaceId="fictional-workspace"
				resourceId={resourceId}
			/>,
		),
	);
}
function video() {
	const element = host?.querySelector("video");
	if (!element) throw new Error("No video element mounted");
	return element;
}
/** happy-dom does not load media; stand in for a resource that is selected. */
function armed(element: HTMLVideoElement, currentSrc = element.src) {
	Object.defineProperty(element, "readyState", {
		configurable: true,
		value: 4,
	});
	Object.defineProperty(element, "currentSrc", {
		configurable: true,
		writable: true,
		value: currentSrc,
	});
	element.play = vi.fn().mockResolvedValue(undefined);
	return element;
}
async function mediaEvent(element: HTMLVideoElement, type: string) {
	await act(async () => {
		element.dispatchEvent(new Event(type));
	});
}
const clip = (url: string, filename = "Fictional demo") => ({
	filename,
	mimeType: "video/webm",
	size: 123,
	url,
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	host = undefined;
	root = undefined;
	state.file = null;
	state.isPending = false;
	state.isError = false;
	state.isFetching = false;
	state.refetch.mockReset();
});

describe("workspace file preview", () => {
	it.each(["video/mp4", "video/webm"])(
		"renders native video controls for %s",
		(mime) => {
			state.isPending = false;
			state.isError = false;
			state.file = clip("/api/workspace-files/fictional/media?sig=1");
			state.file.mimeType = mime;
			expect(render()).toContain("<video");
			expect(render()).toContain('controls=""');
		},
	);
	it("renders PDFs and images inline", () => {
		state.isPending = false;
		state.isError = false;
		state.file = clip("/api/workspace-files/fictional/media?sig=1");
		state.file.mimeType = "application/pdf";
		expect(render()).toContain("<iframe");
		state.file.mimeType = "image/png";
		expect(render()).toContain("<img");
	});
	it("offers arbitrary files as downloads and displays revoked access", () => {
		state.isPending = false;
		state.isError = false;
		state.file = clip("/api/workspace-files/fictional/media?sig=1");
		state.file.mimeType = "text/html";
		expect(render()).not.toContain("<iframe");
		const container = document.createElement("div");
		container.innerHTML = render();
		const download = container.querySelector('a[download="Fictional demo"]');
		expect(download?.textContent).toBe("Download file");
		expect(download?.getAttribute("role")).not.toBe("button");
		expect(download?.getAttribute("href")).toBe(
			"/api/workspace-files/fictional/media?sig=1",
		);
		state.isError = true;
		expect(render()).toContain("no longer have access");
	});
});

describe("media playback identity", () => {
	it("restores position and play intent across a same-file URL rotation", async () => {
		await show(clip("/media/a.webm?sig=1"));
		const first = armed(video());
		await mediaEvent(first, "loadedmetadata");
		first.currentTime = 12;
		await mediaEvent(first, "timeupdate");
		await mediaEvent(first, "play");
		await show(clip("/media/a.webm?sig=2"));
		const second = armed(video());
		expect(second).not.toBe(first);
		await mediaEvent(second, "loadedmetadata");
		expect(second.currentTime).toBe(12);
		expect(second.play).toHaveBeenCalled();
	});
	it("does not transfer playback to a different file or workspace", async () => {
		await show(clip("/media/a.webm?sig=1"));
		const first = armed(video());
		await mediaEvent(first, "loadedmetadata");
		first.currentTime = 12;
		await mediaEvent(first, "timeupdate");
		await mediaEvent(first, "play");
		await show(clip("/media/b.webm?sig=1"), "other-resource");
		const second = armed(video());
		await mediaEvent(second, "loadedmetadata");
		expect(second.currentTime).toBe(0);
		expect(second.play).not.toHaveBeenCalled();
		second.currentTime = 4;
		await mediaEvent(second, "timeupdate");
		await show(clip("/media/b.webm?sig=2"), "other-resource");
		const third = armed(video());
		await mediaEvent(third, "loadedmetadata");
		expect(third.currentTime).toBe(4);
	});
	it("ignores media events for a resource that is no longer loaded", async () => {
		await show(clip("/media/a.webm?sig=1"));
		const stale = armed(video(), "/media/a.webm?sig=0");
		stale.currentTime = 99;
		await mediaEvent(stale, "timeupdate");
		await mediaEvent(stale, "play");
		await show(clip("/media/a.webm?sig=2"));
		const next = armed(video());
		await mediaEvent(next, "loadedmetadata");
		expect(next.currentTime).toBe(0);
		expect(next.play).not.toHaveBeenCalled();
	});
	it("clears playback when the selected file stops being a video", async () => {
		await show(clip("/media/a.webm?sig=1"));
		const first = armed(video());
		await mediaEvent(first, "loadedmetadata");
		first.currentTime = 12;
		await mediaEvent(first, "timeupdate");
		await mediaEvent(first, "play");
		await show({ ...clip("/media/a.png"), mimeType: "image/png" });
		expect(host?.querySelector("video")).toBeNull();
		await show(clip("/media/a.webm?sig=2"));
		const second = armed(video());
		await mediaEvent(second, "loadedmetadata");
		expect(second.currentTime).toBe(0);
		expect(second.play).not.toHaveBeenCalled();
	});
	it("removes media on failure and retries the canonical read", async () => {
		await show(clip("/media/a.webm?sig=1"));
		expect(host?.querySelector("video")).not.toBeNull();
		state.isError = true;
		state.file = null;
		await act(async () =>
			root!.render(
				<WorkspaceFilePreview
					workspaceId="fictional-workspace"
					resourceId="fictional-resource"
				/>,
			),
		);
		expect(host?.querySelector("video")).toBeNull();
		expect(host?.querySelector("img")).toBeNull();
		expect(host?.textContent).toContain("no longer have access");
		const retry = host?.querySelector("button");
		expect(retry?.textContent).toBe("Try again");
		await act(async () => retry!.click());
		expect(state.refetch).toHaveBeenCalledTimes(1);
	});
});
