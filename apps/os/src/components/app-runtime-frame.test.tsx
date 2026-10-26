import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeFrame } from "./app-runtime-frame";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

describe("runtime app frame", () => {
	it("lets the app copy and translate and nothing more", async () => {
		let src = "";
		vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(
			(value: string) => {
				src = value;
			},
		);
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		await act(async () => {
			root.render(
				<AppRuntimeFrame
					html="<p>app</p>"
					title="Fictional app"
					onCall={async () => ({ ok: true, value: null }) as never}
				/>,
			);
		});
		const frame = node.querySelector("iframe");
		expect(frame?.getAttribute("allow")).toBe(
			"clipboard-write; translator; language-detector",
		);
		expect(
			JSON.parse(new URL(src).searchParams.get("permissions") ?? "{}"),
		).toEqual({ clipboardWrite: {}, translator: {}, languageDetector: {} });
		await act(async () => root.unmount());
		node.remove();
	});
});
