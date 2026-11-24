import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ConnectionLinkCard } from "./workspace-chat-link-card";
vi.mock("@/lib/api", () => ({ osApi: {} }));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {},
	workspaceResourcesQueryOptions: vi.fn(),
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("adds multiple checked connections only after the person's click and reports partial success", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const connections = ["mail", "calendar", "crm"].map((id) => ({
		id,
		providerId: id,
		service: id,
		label: id,
		connectionScope: "personal" as const,
		hybrid: true,
		connectedForYou: true,
		access: [],
	}));
	const add = vi.fn(async () => ({
		added: [{ id: "mail", name: "mail" }],
		failed: [{ id: "crm", message: "The account was disconnected" }],
	}));
	try {
		act(() =>
			root.render(
				<ConnectionLinkCard
					connections={connections}
					reason="To plan the customer follow-up."
					onAdd={add}
				/>,
			),
		);
		expect(add).not.toHaveBeenCalled();
		const checks = host.querySelectorAll<HTMLElement>('input[type="checkbox"]');
		expect(checks.length).toBe(3);
		expect(
			[...checks].every(
				(check) =>
					check.getAttribute("aria-checked") === "true" ||
					(check as HTMLInputElement).checked,
			),
		).toBe(true);
		act(() => checks[1]!.click());
		await act(async () =>
			host
				.querySelector<HTMLButtonElement>("button:not([role=checkbox])")!
				.click(),
		);
		expect(add).toHaveBeenCalledExactlyOnceWith(["mail", "crm"]);
		expect(host.textContent).toContain("Added mail");
		expect(host.textContent).toContain("The account was disconnected");
		expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(2);
	} finally {
		act(() => root.unmount());
		host.remove();
	}
});
