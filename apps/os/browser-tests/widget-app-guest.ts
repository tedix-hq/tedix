import { App } from "@modelcontextprotocol/ext-apps";

/** Bundled inline into the opaque srcdoc by widget-apps.spec.ts. */
export function startWidgetGuest() {
	const app = new App(
		{ name: "Tedix browser integration guest", version: "1" },
		{},
		{
			autoResize: false,
		},
	);
	const status = document.querySelector<HTMLElement>("#status");
	const report = (event: string, value: unknown) =>
		void app.updateModelContext({ structuredContent: { event, value } });
	const show = (patch: Record<string, unknown>) => {
		const current = status?.dataset.state
			? (JSON.parse(status.dataset.state) as Record<string, unknown>)
			: {};
		const next = { ...current, ...patch };
		if (status) {
			status.dataset.state = JSON.stringify(next);
			status.textContent = JSON.stringify(next);
		}
	};
	app.addEventListener("toolinput", ({ arguments: args }) => {
		show({ input: args });
		report("input", args);
	});
	app.addEventListener("toolresult", (result) => {
		show({ result });
		report("result", result);
	});
	app.addEventListener("hostcontextchanged", (context) => {
		show({ context });
		report("context", context);
	});
	void app.connect().then(() => {
		const initialization = {
			context: app.getHostContext(),
			capabilities: app.getHostCapabilities(),
		};
		show({
			connected: true,
			...initialization,
		});
		report("connected", initialization);
	});
	document.querySelector("#call-tool")?.addEventListener("click", () => {
		void app
			.callServerTool({
				name: "integration.echo",
				arguments: { value: "from guest" },
			})
			.then((result) => report("outboundResult", result));
	});
}
