// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function worker(windows: object[] = []) {
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
	};
	runInNewContext(
		readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"),
		{ self, URL, Promise, setTimeout, clearTimeout, MessageChannel },
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
