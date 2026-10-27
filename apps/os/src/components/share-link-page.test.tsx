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
	WidgetFrame: (props: { title: string }) => (
		<div data-widget>{props.title}</div>
	),
}));

import { ShareLinkPage } from "./share-link-page";

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER_ID = "ZyXwVuTsRqPoNmLkJiHgFe";
const SESSION = "b".repeat(43);

function opened(overrides: Record<string, unknown> = {}) {
	return {
		organization: { name: "Acme Fictional", logoUrl: null },
		access: "anyone_with_link",
		share: {
			id: "share-1",
			resourceType: "workspace",
			role: "use",
			effectiveRole: "use",
			revisionMode: "living",
			note: null,
			expiresAt: null,
			policyReason: null,
		},
		resource: {
			type: "workspace",
			workspace: { id: "workspace-1", name: "Launch room", description: null },
			gadgets: [],
			openPath: null,
		},
		sessionToken: SESSION,
		...overrides,
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const cleanups: Array<() => void> = [];

async function renderPage(id = ID, url = `/s/${id}`) {
	window.history.replaceState(null, "", url);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<ShareLinkPage id={id} />);
		for (let tick = 0; tick < 5; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

beforeEach(() => {
	window.sessionStorage.clear();
	vi.stubGlobal("fetch", vi.fn());
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ShareLinkPage", () => {
	it("opens a link for anyone and keeps its session under the link id", async () => {
		vi.mocked(fetch).mockResolvedValue(json(opened()));
		const container = await renderPage();
		expect(fetch).toHaveBeenCalledWith(
			"/api/os-shared/open",
			expect.objectContaining({ body: JSON.stringify({ id: ID }) }),
		);
		expect(window.sessionStorage.getItem(`tedix.os.share.${ID}`)).toBe(SESSION);
		expect(container.querySelector("h1")?.textContent).toBe("Launch room");
		expect(container.textContent).toContain("no sign-in needed");
	});

	it("resumes this tab's session instead of opening the link again", async () => {
		window.sessionStorage.setItem(`tedix.os.share.${ID}`, SESSION);
		window.sessionStorage.setItem(`tedix.os.share.${OTHER_ID}`, "other");
		vi.mocked(fetch).mockResolvedValue(
			json(opened({ sessionToken: undefined })),
		);
		await renderPage();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			"/api/os-shared/session",
			expect.objectContaining({
				body: JSON.stringify({ sessionToken: SESSION }),
			}),
		);
		// Another link's session in the same tab is untouched.
		expect(window.sessionStorage.getItem(`tedix.os.share.${OTHER_ID}`)).toBe(
			"other",
		);
	});

	it("opens the link again when its stored session has ended", async () => {
		window.sessionStorage.setItem(`tedix.os.share.${ID}`, "ended-session");
		vi.mocked(fetch)
			.mockResolvedValueOnce(json("gone", 404))
			.mockResolvedValueOnce(json(opened()));
		const container = await renderPage();
		expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
			"/api/os-shared/session",
			"/api/os-shared/open",
		]);
		expect(window.sessionStorage.getItem(`tedix.os.share.${ID}`)).toBe(SESSION);
		expect(container.textContent).toContain("Launch room");
	});

	it("sends a signed-out visitor to sign in and back to the same link", async () => {
		const assign = vi.fn();
		vi.spyOn(window, "location", "get").mockReturnValue({
			...window.location,
			href: `${window.location.origin}/s/${ID}`,
			assign,
		} as Location);
		vi.mocked(fetch).mockResolvedValue(
			json({ ...opened({ sessionToken: undefined }), needsSignIn: true }),
		);
		await renderPage();
		expect(assign).toHaveBeenCalledWith(`/s/${ID}?sign-in`);
	});

	it("says the account has no access when sign-in did not help", async () => {
		vi.mocked(fetch).mockResolvedValue(
			json({ ...opened({ sessionToken: undefined }), needsSignIn: true }),
		);
		const container = await renderPage(ID, `/s/${ID}?sign-in`);
		expect(window.location.search).toBe("");
		expect(container.textContent).toContain("Your account doesn't have access");
	});

	it("refuses a malformed id without asking the server", async () => {
		const container = await renderPage("not-a-link");
		expect(fetch).not.toHaveBeenCalled();
		expect(container.querySelector("[data-share-unavailable]")).not.toBeNull();
	});
});
