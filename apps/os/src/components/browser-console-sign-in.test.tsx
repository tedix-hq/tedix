import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ToolPolicySchema } from "@tedix/api-contract/schemas/tedi";
import { BrowserConsoleSignIn } from "./browser-console-sign-in";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	if (root) await act(async () => root.unmount());
});
const policy = ToolPolicySchema.parse({
	browserEgress: {
		allowedHostnames: ["example.com"],
		deniedHostnames: ["private.example.com"],
	},
	browserSession: { mode: "persistent" },
});

it("adds and removes only the named preset, preserving session and custom rules", async () => {
	const save = vi.fn();
	root = createRoot(host);
	await act(async () =>
		root.render(
			<BrowserConsoleSignIn policy={policy} disabled={false} onChange={save} />,
		),
	);
	await act(async () =>
		host.querySelector<HTMLButtonElement>("[role=switch]")!.click(),
	);
	const enabled = save.mock.calls[0]![0];
	expect(enabled).toEqual({
		...policy,
		browserEgress: {
			...policy.browserEgress,
			presets: ["tedix-console-sign-in"],
		},
	});
	await act(async () =>
		root.render(
			<BrowserConsoleSignIn
				policy={enabled}
				disabled={false}
				onChange={save}
			/>,
		),
	);
	await act(async () =>
		host.querySelector<HTMLButtonElement>("[role=switch]")!.click(),
	);
	expect(save.mock.calls[1]![0]).toEqual({
		...policy,
		browserEgress: { ...policy.browserEgress, presets: [] },
	});
});
it("does not save when the admin control is disabled", async () => {
	const save = vi.fn();
	root = createRoot(host);
	await act(async () =>
		root.render(
			<BrowserConsoleSignIn policy={null} disabled onChange={save} />,
		),
	);
	await act(async () =>
		host.querySelector<HTMLButtonElement>("[role=switch]")!.click(),
	);
	expect(save).not.toHaveBeenCalled();
});
