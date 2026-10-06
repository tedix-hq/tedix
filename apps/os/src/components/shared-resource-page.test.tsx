import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

vi.mock("@/lib/api", () => ({
	osApi: {
		osShares: { reviews: { get: async () => ({ batch: null, feedback: [] }) } },
	},
}));

vi.mock("@/components/widget-frame", () => ({
	WidgetFrame: (props: {
		appSlug: string;
		resourceUri: string;
		title: string;
	}) => (
		<div data-widget={`${props.appSlug}:${props.resourceUri}`}>
			{props.title}
		</div>
	),
}));

import { SharedResourcePage } from "./shared-resource-page";

const TOKEN = "a".repeat(43);
const SESSION = "b".repeat(43);

function payload(role: "use" | "build") {
	return {
		share: {
			id: "share-1",
			resourceType: "gadget",
			role,
			effectiveRole: role,
			revisionMode: "living",
			note: "Review launch metrics",
			expiresAt: null,
			policyReason: null,
		},
		resource: {
			type: "gadget",
			gadget: {
				id: "gadget-1",
				workspaceId: "workspace-1",
				name: "Launch dashboard",
				description: "Interactive launch view",
			},
			revision: {
				id: "revision-1",
				revision: 3,
				manifest: {
					entry: "ui://widgets/mcp-app/tedix/r/launch.html",
					...(role === "build"
						? { capabilities: ["metrics.read"], notes: "source" }
						: {}),
				},
			},
			openPath: role === "build" ? "/workspace/workspace-1" : null,
		},
		sessionToken: SESSION,
	};
}

const cleanups: Array<() => void> = [];

async function renderPage(url = `/shared#token=${TOKEN}`, strict = false) {
	window.history.replaceState(null, "", url);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			strict ? (
				<StrictMode>
					<SharedResourcePage />
				</StrictMode>
			) : (
				<SharedResourcePage />
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

beforeEach(() => {
	vi.useRealTimers();
	window.sessionStorage.clear();
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SharedResourcePage", () => {
	it("redeems from the fragment, removes it, and gives use access no source or build path", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		const container = await renderPage();
		expect(window.location.hash).toBe("");
		expect(window.sessionStorage.getItem("tedix.os.share.session.v1")).toBe(
			SESSION,
		);
		expect(Object.values(window.sessionStorage).join()).not.toContain(TOKEN);
		expect(fetch).toHaveBeenCalledWith(
			"/api/os-shared/redeem",
			expect.objectContaining({ body: JSON.stringify({ token: TOKEN }) }),
		);
		expect(container.textContent).toContain("Launch dashboard");
		expect(container.querySelector("[data-widget]")).not.toBeNull();
		expect(container.textContent).not.toContain("Shared source manifest");
		expect(container.textContent).not.toContain("Open authenticated Canvas");
	});

	it("shows source and the separately-authorized Canvas path for build access", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify(payload("build")), { status: 200 }),
		);
		const container = await renderPage();
		expect(container.textContent).toContain("Shared source manifest");
		expect(container.textContent).toContain("Open authenticated Canvas");
		expect(container.textContent).toContain("rechecks your tenant membership");
	});

	it("replaces an already-open resource when the live session is revoked", async () => {
		vi.useFakeTimers();
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(payload("use")), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response("not found", { status: 404 }));
		window.history.replaceState(null, "", `/shared#token=${TOKEN}`);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(<SharedResourcePage />);
			await vi.runOnlyPendingTimersAsync();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(container.textContent).toContain("no longer available");
		expect(
			window.sessionStorage.getItem("tedix.os.share.session.v1"),
		).toBeNull();
		expect(container.querySelector("[data-widget]")).toBeNull();
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});
	it("resumes after reload through a server-validated session without the original link secret", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		await renderPage();
		while (cleanups.length) cleanups.pop()?.();
		const next = payload("use");
		delete (next as { sessionToken?: string }).sessionToken;
		vi.mocked(fetch)
			.mockClear()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(next), { status: 200 }),
			);
		const container = await renderPage("/shared");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			"/api/os-shared/session",
			expect.objectContaining({
				body: JSON.stringify({ sessionToken: SESSION }),
			}),
		);
		expect(container.textContent).toContain("Launch dashboard");
		expect(window.sessionStorage.getItem("tedix.os.share.session.v1")).toBe(
			SESSION,
		);
	});
	it("clears invalid stored sessions and renders no widget or old batch", async () => {
		window.sessionStorage.setItem("tedix.os.share.session.v1", SESSION);
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("revoked", { status: 404 }),
		);
		const container = await renderPage("/shared");
		expect(container.textContent).toContain("no longer available");
		expect(
			window.sessionStorage.getItem("tedix.os.share.session.v1"),
		).toBeNull();
		expect(container.querySelector("[data-widget]")).toBeNull();
	});
	it("does not resume an old share when a newly supplied link fails", async () => {
		window.sessionStorage.setItem("tedix.os.share.session.v1", SESSION);
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("expired", { status: 404 }),
		);
		const container = await renderPage();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			"/api/os-shared/redeem",
			expect.anything(),
		);
		expect(container.querySelector("[data-widget]")).toBeNull();
		expect(
			window.sessionStorage.getItem("tedix.os.share.session.v1"),
		).toBeNull();
	});
	it("opens a freshly redeemed share when per-tab storage is blocked", async () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		const container = await renderPage();
		expect(container.textContent).toContain("Launch dashboard");
		expect(container.querySelector("[data-widget]")).not.toBeNull();
		expect(window.location.hash).toBe("");
	});
	it("redeems a different share fragment in the same tab without showing the old gadget", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		const container = await renderPage();
		const next = payload("use");
		next.resource.gadget.name = "Second review";
		next.sessionToken = "c".repeat(43);
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(next), { status: 200 }),
		);
		await act(async () => {
			window.history.replaceState(null, "", `/shared#token=${"d".repeat(43)}`);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(container.textContent).toContain("Second review");
		expect(container.textContent).not.toContain("Launch dashboard");
		expect(window.location.hash).toBe("");
		expect(window.sessionStorage.getItem("tedix.os.share.session.v1")).toBe(
			next.sessionToken,
		);
	});
	it("ignores a late response from the old share after a new fragment is opened", async () => {
		let resolveOld: (response: Response) => void = () => {};
		vi.mocked(fetch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		const container = await renderPage();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("revoked", { status: 404 }),
		);
		await act(async () => {
			window.history.replaceState(null, "", `/shared#token=${"d".repeat(43)}`);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			resolveOld(new Response(JSON.stringify(payload("use")), { status: 200 }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(container.textContent).toContain("no longer available");
		expect(container.querySelector("[data-widget]")).toBeNull();
		expect(
			window.sessionStorage.getItem("tedix.os.share.session.v1"),
		).toBeNull();
	});
	it("survives StrictMode effect replay without retaining the original link secret", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		const container = await renderPage(`/shared#token=${TOKEN}`, true);
		expect(container.textContent).toContain("Launch dashboard");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(window.sessionStorage.getItem("tedix.os.share.session.v1")).toBe(
			SESSION,
		);
		expect(window.location.hash).toBe("");
	});
});
