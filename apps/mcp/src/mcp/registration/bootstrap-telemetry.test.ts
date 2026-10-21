import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ServerContext } from "../server-context";
import { registerBootstrapTools } from "./bootstrap";

afterEach(() => vi.restoreAllMocks());

describe("widget analytics failure isolation", () => {
	it.each(["throw", "reject", "schedule"])(
		"acknowledges the event when telemetry writers %s",
		async (failure) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const trackWidgetEvents = vi.fn(() => {
				if (failure === "throw")
					throw new Error("Analytics Engine write limit exceeded");
				return Promise.reject(
					new Error("Analytics Engine write limit exceeded"),
				);
			});
			const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
			const pending: Promise<unknown>[] = [];
			const ctx = {
				server: {
					registerTool: (
						name: string,
						_config: unknown,
						handler: (input: unknown) => Promise<unknown>,
					) => {
						handlers.set(name, handler);
						return {};
					},
				},
				registeredTools: new Map(),
				app: { name: "Fixture app" },
				appId: "fixture-app",
				traceId: "fixture-trace",
				apiClient: { analytics: { trackWidgetEvents } },
				ctx: {
					waitUntil: (p: Promise<unknown>) => {
						if (failure === "schedule") throw new Error("context closed");
						pending.push(p);
					},
				},
			} as unknown as ServerContext;
			registerBootstrapTools(ctx);
			await expect(
				handlers.get("__track_widget_analytics")!({ eventType: "item_click" }),
			).resolves.toMatchObject({ structuredContent: { success: true } });
			await Promise.all(pending);
			expect(trackWidgetEvents).toHaveBeenCalledTimes(1);
		},
	);
});
