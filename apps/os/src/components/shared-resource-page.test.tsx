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

async function renderPage() {
	window.history.replaceState(null, "", `/shared#token=${TOKEN}`);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<SharedResourcePage />);
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
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.unstubAllGlobals();
});

describe("SharedResourcePage", () => {
	it("redeems from the fragment, removes it, and gives use access no source or build path", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify(payload("use")), { status: 200 }),
		);
		const container = await renderPage();
		expect(window.location.hash).toBe("");
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
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});
});
