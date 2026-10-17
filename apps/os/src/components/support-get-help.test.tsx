import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
const file = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ osApi: { support: { file } } }));
vi.mock("@/components/kumo/checkbox", () => ({
	Checkbox: ({
		checked,
		onCheckedChange,
		label,
	}: {
		checked: boolean;
		onCheckedChange: (checked: boolean) => void;
		label: string;
	}) => (
		<button
			role="checkbox"
			aria-label={label}
			aria-checked={checked}
			onClick={() => onCheckedChange(!checked)}
		/>
	),
}));
import { SupportGetHelp } from "./support-get-help";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("Get help consent preview", () => {
	it("captures only the route and known error and resets approval when the report changes", async () => {
		const client = new QueryClient(),
			container = document.createElement("div");
		document.body.append(container);
		window.history.replaceState({}, "", "/apps/example?token=private#fragment");
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<SupportGetHelp organization="Example team" />
				</QueryClientProvider>,
			),
		);
		const button = (name: string) =>
			Array.from(document.querySelectorAll("button")).find(
				(x) => x.textContent === name,
			)!;
		try {
			await act(async () => button("Get help").click());
			const fields = Array.from(
				document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
					"input:not([type=checkbox]),textarea",
				),
			);
			expect(fields.find((x) => x.value === "/apps/example")).toBeDefined();
			expect(document.body.textContent).not.toContain("token=private");
			expect(button("File support request").disabled).toBe(true);
			const set = (
				field: HTMLInputElement | HTMLTextAreaElement,
				value: string,
			) =>
				act(() => {
					const proto =
						field instanceof HTMLTextAreaElement
							? HTMLTextAreaElement.prototype
							: HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
						field,
						value,
					);
					field.dispatchEvent(new Event("input", { bubbles: true }));
				});
			set(fields[0]!, "Connection issue");
			set(fields[1]!, "Connect successfully");
			set(fields[2]!, "Cookie: private-session\nAn error appeared");
			await act(async () => button("Preview report").click());
			expect(document.querySelector("pre")?.textContent).toContain(
				"Cookie: [removed]",
			);
			expect(document.querySelector("pre")?.textContent).not.toContain(
				"private-session",
			);
			const checkbox =
				document.querySelector<HTMLElement>('[role="checkbox"]') ??
				document.querySelector<HTMLInputElement>('input[type="checkbox"]');
			expect(checkbox).not.toBeNull();
			await act(async () => checkbox!.click());
			expect(button("File support request").disabled).toBe(false);
			set(fields[0]!, "Updated report");
			expect(button("File support request").disabled).toBe(true);
			expect(file).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			container.remove();
			client.clear();
			window.history.replaceState({}, "", "/");
		}
	});
});
