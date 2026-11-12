// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function worker(windows: object[] = [], navigator: object = {}) {
	const handlers: Record<string, (event: unknown) => void> = {};
	const showNotification = vi.fn();
	const openWindow = vi.fn();
	const self = {
		location: { origin: "https://team.os.example.test" },
		addEventListener: (name: string, handler: (event: unknown) => void) => {
			handlers[name] = handler;
		},
		clients: { matchAll: async () => windows, openWindow, claim: vi.fn() },
		registration: { showNotification },
		navigator,
	};
	runInNewContext(
		readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"),
		{ self, URL, Promise, setTimeout, clearTimeout, MessageChannel, Number },
	);
	const dispatch = async (name: string, extra: object) => {
		let work: Promise<unknown> | undefined;
		handlers[name]!({
			...extra,
			waitUntil: (promise: Promise<unknown>) => {
				work = promise;
			},
		});
		await work;
	};
	return { dispatch, showNotification, openWindow };
}
describe("installed app", () => {
	it("declares what a phone needs to install it: standalone display, a start page, and plain and maskable icons", () => {
		const manifest = JSON.parse(
			readFileSync(
				new URL("../../public/manifest.webmanifest", import.meta.url),
				"utf8",
			),
		);
		expect(manifest.display).toBe("standalone");
		expect(manifest.start_url).toBe("/work");
		expect(manifest.scope).toBe("/");
		expect(manifest.name && manifest.short_name).toBeTruthy();
		expect(manifest.theme_color && manifest.background_color).toBeTruthy();
		const icons = manifest.icons as {
			src: string;
			sizes: string;
			purpose: string;
		}[];
		for (const size of ["192x192", "512x512"]) {
			expect(
				icons.some((icon) => icon.sizes === size && icon.purpose === "any"),
			).toBe(true);
		}
		expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
		for (const icon of [
			...icons,
			...manifest.shortcuts.flatMap(
				(shortcut: { icons: { src: string }[] }) => shortcut.icons,
			),
		]) {
			expect(() =>
				readFileSync(new URL(`../../public${icon.src}`, import.meta.url)),
			).not.toThrow();
		}
	});

	it("puts a push's unread total on the app icon and clears it at zero", async () => {
		const setAppBadge = vi.fn(async () => {});
		const clearAppBadge = vi.fn(async () => {});
		const w = worker([], { setAppBadge, clearAppBadge });
		const push = (unreadCount: unknown) =>
			w.dispatch("push", {
				data: { json: () => ({ title: "New", body: "One", unreadCount }) },
			});
		await push(4);
		expect(setAppBadge).toHaveBeenCalledWith(4);
		await push(0);
		expect(clearAppBadge).toHaveBeenCalledTimes(1);
		await push(undefined);
		expect(setAppBadge).toHaveBeenCalledTimes(1);
		expect(w.showNotification).toHaveBeenCalledTimes(3);
	});
});

describe("push service worker", () => {
	it("suppresses a visible matching chat and displays a different chat notification", async () => {
		const client = {
			visibilityState: "visible",
			postMessage: (_message: object, ports: MessagePort[]) =>
				ports[0]!.postMessage({ conversationId: "chat-a" }),
		};
		const w = worker([client]);
		await w.dispatch("push", {
			data: {
				json: () => ({
					title: "Approval needed",
					body: "A decision is waiting.",
					conversationId: "chat-a",
				}),
			},
		});
		expect(w.showNotification).not.toHaveBeenCalled();
		await w.dispatch("push", {
			data: {
				json: () => ({
					title: "Approval needed",
					body: "A decision is waiting.",
					conversationId: "chat-b",
				}),
			},
		});
		expect(w.showNotification).toHaveBeenCalledWith(
			"Approval needed",
			expect.objectContaining({ data: { url: "/work?view=deck" } }),
		);
	});
	it("opens only the same-origin Deck even if a payload supplies another URL", async () => {
		const w = worker();
		const close = vi.fn();
		await w.dispatch("notificationclick", {
			notification: { close, data: { url: "https://evil.example.test" } },
		});
		expect(close).toHaveBeenCalled();
		expect(w.openWindow).toHaveBeenCalledWith(
			"https://team.os.example.test/work?view=deck",
		);
	});
	it("ignores malformed push payloads", async () => {
		const w = worker();
		await w.dispatch("push", {
			data: {
				json: () => {
					throw new Error("bad json");
				},
			},
		});
		expect(w.showNotification).not.toHaveBeenCalled();
	});
});
