import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock(
	"@/components/home-execution-detail",
	async () => await new Promise(() => {}),
);
vi.mock("@/lib/use-media-query", () => ({ useMediaQuery: () => false }));

import { ChatExecutionDetailsProvider } from "./chat-execution-sheet";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps the Home run identity copyable while the detail module is still loading", async () => {
	const runId = "11111111-1111-4111-8111-111111111111";
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(
				<ChatExecutionDetailsProvider
					runId={runId}
					onOpen={() => {}}
					onClose={() => {}}
				>
					<span>Chat</span>
				</ChatExecutionDetailsProvider>,
			);
		});
		expect(document.body.textContent).toContain("Response details");
		expect(document.body.textContent).toContain("Home run");
		expect(document.body.textContent).toContain(runId);
		expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
		expect(
			[...document.querySelectorAll("button")].some((button) =>
				/copy/i.test(button.getAttribute("aria-label") ?? ""),
			),
		).toBe(true);
	} finally {
		act(() => root.unmount());
		host.remove();
	}
});
