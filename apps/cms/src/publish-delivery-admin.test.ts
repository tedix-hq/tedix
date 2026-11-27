// @vitest-environment happy-dom
import {
	act,
	createElement,
	createRoot,
	templateI18n,
	withTemplateI18n,
} from "./test-utils/template-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
	pages,
	PublishDeliveries,
} from "../templates/tedix/src/plugins/tedix-site-builder/admin";

beforeEach(() => templateI18n.loadAndActivate({ locale: "en", messages: {} }));
afterEach(() => vi.unstubAllGlobals());
it("shows pending and failed totals and queues a CSRF-protected retry", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		requests.push({ url, init });
		if (url.endsWith("retry")) return Response.json({ queued: true });
		return Response.json({
			pending: 3,
			failed: 1,
			receipts: [
				{
					id: "a".repeat(64),
					recipient: "reader@example.com",
					status: "failed",
					attempts: 8,
				},
			],
		});
	});
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	window.history.replaceState(
		{},
		"",
		"/blog/_emdash/admin/plugins/tedix-site-builder/development",
	);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(withTemplateI18n(createElement(PublishDeliveries)));
		});
		expect(container.textContent).toContain("3 pending · 1 failed");
		expect(container.textContent).toContain("Memory sync");
		expect(container.textContent).toContain("Newsletter");
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry delivery",
		)!;
		await act(async () => {
			retry.click();
		});
		const request = requests.find((request) => request.url.endsWith("retry"));
		expect(request?.url).toBe(
			"/blog/_emdash/api/plugins/tedix-tedi-bridge/deliveries/retry",
		);
		expect(request?.init?.method).toBe("POST");
		expect(new Headers(request?.init?.headers).get("X-EmDash-Request")).toBe(
			"1",
		);
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			id: "a".repeat(64),
		});
	} finally {
		await act(async () => {
			root.unmount();
		});
	}
});

it("leaves a mounted editor for its pinned organization without using the public site host", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("__TEDIX_OS_SITES_URL__", "https://acme.os.tedix.dev/sites");
	const replace = vi
		.spyOn(window.location, "replace")
		.mockImplementation(() => {});
	window.history.replaceState(
		{},
		"",
		"/blog/_emdash/admin/plugins/tedix-site-builder/back-to-tedix",
	);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(withTemplateI18n(createElement(pages["/back-to-tedix"])));
		});
		expect(replace).toHaveBeenCalledExactlyOnceWith(
			"https://acme.os.tedix.dev/sites",
		);
		expect(container.querySelector("a")?.href).toBe(
			"https://acme.os.tedix.dev/sites",
		);
	} finally {
		await act(async () => root.unmount());
		replace.mockRestore();
	}
});
