import {
	App,
	type AppEventMap,
	type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;
type DisplayMode = "inline" | "fullscreen" | "pip";
type ViewState = Record<string, unknown>;

/** ChatGPT-only extensions; portable operations use the MCP Apps connection. */
interface ChatGptHost {
	widgetState?: { modelContent?: ViewState; privateContent?: unknown };
	view?: { mode?: string; params?: Record<string, unknown> };
	setWidgetState?: (state: Record<string, unknown>) => Promise<unknown> | void;
	requestModal?: (options: Record<string, unknown>) => Promise<unknown> | void;
	setOpenInAppUrl?: (options: { href: string }) => Promise<unknown> | void;
}
export function chatGptHost(): ChatGptHost | undefined {
	return typeof window === "undefined"
		? undefined
		: (window as unknown as { openai?: ChatGptHost }).openai;
}

interface Snapshot {
	context: McpUiHostContext;
	input?: Record<string, unknown>;
	result?: ToolResult;
	viewState: ViewState;
	connected: boolean;
	error?: Error;
}
const INITIAL: Snapshot = { context: {}, viewState: {}, connected: false };
const errorOf = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

/** One source-checked SDK connection per widget document, shared by React islands. */
export class WidgetHost {
	private snapshot: Snapshot = INITIAL;
	private listeners = new Set<() => void>();
	private app: App | null = null;
	private ready: Promise<void> | null = null;
	private mounts = 0;
	private description: string | null = null;
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<Snapshot>) {
		this.snapshot = { ...this.snapshot, ...patch };
		this.listeners.forEach((listener) => listener());
	}
	mount = () => {
		this.mounts++;
		if (
			this.mounts === 1 &&
			typeof window !== "undefined" &&
			window.parent !== window
		) {
			const app = new App({ name: "Tedix Widget", version: "2.0.0" }, {});
			this.app = app;
			const update = (patch: Partial<Snapshot>) => {
				if (this.app === app) this.update(patch);
			};
			const onToolInput = ({ arguments: input }: AppEventMap["toolinput"]) =>
				update({ input });
			const onToolInputPartial = ({
				arguments: input,
			}: AppEventMap["toolinputpartial"]) => update({ input });
			const onToolResult = (result: AppEventMap["toolresult"]) =>
				update({ result, error: undefined });
			const onToolCancelled = () =>
				update({ error: new Error("The tool was cancelled.") });
			const onHostContextChanged = (
				context: AppEventMap["hostcontextchanged"],
			) => update({ context: { ...this.snapshot.context, ...context } });
			app.addEventListener("toolinput", onToolInput);
			app.addEventListener("toolinputpartial", onToolInputPartial);
			app.addEventListener("toolresult", onToolResult);
			app.addEventListener("toolcancelled", onToolCancelled);
			app.addEventListener("hostcontextchanged", onHostContextChanged);
			this.removeAppListeners = () => {
				app.removeEventListener("toolinput", onToolInput);
				app.removeEventListener("toolinputpartial", onToolInputPartial);
				app.removeEventListener("toolresult", onToolResult);
				app.removeEventListener("toolcancelled", onToolCancelled);
				app.removeEventListener("hostcontextchanged", onHostContextChanged);
			};
			const syncChatGpt = () => {
				const viewState = chatGptHost()?.widgetState?.modelContent;
				update(viewState ? { viewState } : {});
			};
			window.addEventListener("openai:set_globals", syncChatGpt);
			this.removeChatGptListener = () =>
				window.removeEventListener("openai:set_globals", syncChatGpt);
			syncChatGpt();
			this.ready = app
				.connect()
				.then(() =>
					update({ connected: true, context: app.getHostContext() ?? {} }),
				);
			void this.ready.catch((error) => {
				if (this.app === app) {
					console.error("Widget connection failed:", error);
					update({ error: errorOf(error) });
				}
			});
		}
		return () => {
			if (--this.mounts !== 0) return;
			const app = this.app;
			this.app = null;
			this.ready = null;
			this.removeChatGptListener?.();
			this.removeChatGptListener = undefined;
			this.removeAppListeners?.();
			this.removeAppListeners = undefined;
			this.snapshot = INITIAL;
			this.description = null;
			void app
				?.close()
				.catch((error) => console.error("Widget disconnect failed:", error));
		};
	};
	private removeChatGptListener?: () => void;
	private removeAppListeners?: () => void;
	private async connection() {
		const app = this.app;
		if (!app)
			throw new Error(
				"Open this widget in a connected host to run this action.",
			);
		await this.ready;
		if (app !== this.app) throw new Error("The widget connection was closed.");
		return app;
	}
	callTool = async (name: string, args: Record<string, unknown>) => {
		const result = await (
			await this.connection()
		).callServerTool({ name, arguments: args });
		if (result.isError)
			throw new Error(
				result.content
					?.flatMap((item) => (item.type === "text" ? [item.text] : []))
					.join("\n") || "The tool could not complete this action.",
			);
		return result;
	};
	requestDisplayMode = async (mode: string) => {
		if (mode !== "inline" && mode !== "fullscreen" && mode !== "pip")
			throw new Error("Unsupported display mode.");
		const app = await this.connection();
		const result = await app.requestDisplayMode({ mode: mode as DisplayMode });
		if (app === this.app)
			this.update({
				context: { ...this.snapshot.context, displayMode: result.mode },
			});
	};
	sendFollowUp = async (message: string) => {
		const result = await (
			await this.connection()
		).sendMessage({ role: "user", content: [{ type: "text", text: message }] });
		if (result.isError)
			throw new Error("The host could not accept this follow-up.");
	};
	openLink = async (url: string) => {
		const result = await (await this.connection()).openLink({ url });
		if (result.isError) throw new Error("The host could not open this link.");
	};
	setViewState = (state: ViewState) => {
		this.update({ viewState: state });
		return this.publishContext();
	};
	setDescription = (description: string | null) => {
		this.description = description;
		return this.publishContext();
	};
	private async publishContext() {
		const host = chatGptHost();
		const state = {
			...this.snapshot.viewState,
			__view_context: this.description ?? "",
		};
		if (host?.setWidgetState) {
			await host.setWidgetState({
				privateContent: {},
				...host.widgetState,
				modelContent: state,
			});
		} else if (this.app) {
			await (
				await this.connection()
			).updateModelContext({
				structuredContent: state,
				content: [{ type: "text", text: JSON.stringify(state) }],
			});
		}
	}
}
export const widgetHost = new WidgetHost();
