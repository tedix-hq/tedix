// @vitest-environment happy-dom
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
const sdk = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("@modelcontextprotocol/ext-apps", () => ({
	App: class {
		connect = vi.fn(async () => {});
		close = vi.fn(async () => {});
		getHostContext = () => ({ theme: "dark", displayMode: "inline" });
		callServerTool = vi.fn(async () => ({
			content: [],
			structuredContent: null,
		}));
		requestDisplayMode = vi.fn(async () => ({ mode: "fullscreen" }));
		sendMessage = vi.fn(async () => ({}));
		updateModelContext = vi.fn(async () => ({}));
		listeners = new Map<string, Set<(params: unknown) => void>>();
		addEventListener(event: string, handler: (params: unknown) => void) {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set());
			this.listeners.get(event)!.add(handler);
		}
		removeEventListener(event: string, handler: (params: unknown) => void) {
			this.listeners.get(event)?.delete(handler);
		}
		emit(event: string, params: unknown) {
			this.listeners.get(event)?.forEach((handler) => handler(params));
		}
		constructor() {
			sdk.instances.push(this);
		}
	},
}));
import { WidgetHost } from "./widget-host";
beforeEach(() => {
	sdk.instances.length = 0;
	vi.spyOn(window, "parent", "get").mockReturnValue({} as Window);
});
afterEach(() => {
	vi.restoreAllMocks();
	delete (window as any).openai;
});

describe("widget guest connection", () => {
	it("owns a connection across subscribers, closes it, and ignores stale callbacks after remount", async () => {
		const host = new WidgetHost();
		const release = host.mount();
		const second = host.mount();
		await Promise.resolve();
		expect(sdk.instances).toHaveLength(1);
		expect(host.getSnapshot().context.theme).toBe("dark");
		const old = sdk.instances[0];
		release();
		expect(old.close).not.toHaveBeenCalled();
		second();
		expect(old.close).toHaveBeenCalledOnce();
		const stop = host.mount();
		await Promise.resolve();
		for (const handlers of old.listeners.values())
			expect(handlers.size).toBe(0);
		old.emit("toolresult", { structuredContent: { stale: true } });
		expect(host.getSnapshot().result).toBeUndefined();
		stop();
	});
	it("preserves JSON tool data and rejects tool failures without replacing protocol errors", async () => {
		const host = new WidgetHost();
		const stop = host.mount();
		await Promise.resolve();
		const app = sdk.instances[0];
		for (const value of [null, [1, 2], 0, false]) {
			app.emit("toolresult", { content: [], structuredContent: value });
			expect(host.getSnapshot().result?.structuredContent).toEqual(value);
		}
		const error = Object.assign(new Error("denied"), { code: -32000 });
		app.callServerTool.mockRejectedValueOnce(error);
		await expect(host.callTool("save", {})).rejects.toBe(error);
		app.callServerTool.mockResolvedValueOnce({
			isError: true,
			content: [{ type: "text", text: "Not authorized" }],
		});
		await expect(host.callTool("save", {})).rejects.toThrow("Not authorized");
		await expect(host.callTool("read", {})).resolves.toMatchObject({
			structuredContent: null,
		});
		stop();
	});
	it("uses acknowledged display mode and follows host exit notifications", async () => {
		const host = new WidgetHost();
		const stop = host.mount();
		await Promise.resolve();
		const app = sdk.instances[0];
		app.requestDisplayMode.mockResolvedValueOnce({ mode: "inline" });
		await host.requestDisplayMode("fullscreen");
		expect(host.getSnapshot().context.displayMode).toBe("inline");
		await host.requestDisplayMode("fullscreen");
		expect(host.getSnapshot().context.displayMode).toBe("fullscreen");
		app.requestDisplayMode.mockRejectedValueOnce(new Error("Denied"));
		await expect(host.requestDisplayMode("inline")).rejects.toThrow("Denied");
		expect(host.getSnapshot().context.displayMode).toBe("fullscreen");
		app.emit("hostcontextchanged", { displayMode: "inline" });
		expect(host.getSnapshot().context.displayMode).toBe("inline");
		stop();
	});
	it("sends follow-ups through ui/message and surfaces rejection", async () => {
		const host = new WidgetHost();
		const stop = host.mount();
		await host.sendFollowUp("hello");
		const app = sdk.instances[0];
		expect(app.sendMessage).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
		app.sendMessage.mockResolvedValueOnce({ isError: true });
		await expect(host.sendFollowUp("again")).rejects.toThrow(
			"could not accept",
		);
		stop();
	});
	it("publishes model description together with interaction state", async () => {
		const host = new WidgetHost();
		const stop = host.mount();
		await host.setViewState({ selected: 2 });
		await host.setDescription("Two results");
		expect(sdk.instances[0].updateModelContext).toHaveBeenLastCalledWith(
			expect.objectContaining({
				structuredContent: { selected: 2, __view_context: "Two results" },
			}),
		);
		stop();
	});
	it("preserves ChatGPT model/private state and restores incoming view state", async () => {
		const setWidgetState = vi.fn();
		(window as any).openai = {
			widgetState: {
				privateContent: { keep: true },
				modelContent: { selected: 1 },
			},
			setWidgetState,
		};
		const host = new WidgetHost();
		const stop = host.mount();
		expect(host.getSnapshot().viewState).toEqual({ selected: 1 });
		await host.setViewState({ selected: 2 });
		expect(setWidgetState).toHaveBeenCalledWith({
			privateContent: { keep: true },
			modelContent: { selected: 2, __view_context: "" },
		});
		expect(sdk.instances[0].updateModelContext).not.toHaveBeenCalled();
		(window as any).openai.widgetState.modelContent = { selected: 3 };
		window.dispatchEvent(new CustomEvent("openai:set_globals"));
		expect(host.getSnapshot().viewState).toEqual({ selected: 3 });
		delete (window as any).openai.widgetState;
		const listener = vi.fn();
		const unsubscribe = host.subscribe(listener);
		window.dispatchEvent(new CustomEvent("openai:set_globals"));
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
		stop();
	});
	it("keeps standalone state local and refuses tool dispatch without a host", async () => {
		vi.restoreAllMocks();
		const host = new WidgetHost();
		const stop = host.mount();
		await host.setViewState({ selected: 1 });
		expect(host.getSnapshot().viewState).toEqual({ selected: 1 });
		await expect(host.callTool("save", {})).rejects.toThrow("connected host");
		stop();
	});
});
