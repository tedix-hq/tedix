import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import type { MachineAction } from "@/lib/machine-activity";
import { MachineActivity } from "./machine-activity";

const action = (overrides: Partial<MachineAction>): MachineAction => ({
	key: "a",
	kind: "read",
	target: "README.md",
	machine: "studio-mac",
	status: "done",
	text: "",
	cut: false,
	error: null,
	exitCode: null,
	change: null,
	callId: null,
	...overrides,
});

describe("MachineActivity", () => {
	it("folds several actions into one line and opens a row to its result", async () => {
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		await act(async () =>
			root.render(
				<ul>
					<MachineActivity
						defaultOpen
						loadFull={async () => ({
							status: "done",
							result: "the whole file",
						})}
						actions={[
							action({
								text: Array.from({ length: 20 }, (_, n) => `line ${n}`).join(
									"\n",
								),
								cut: true,
								callId: "call-1",
							}),
							action({
								key: "b",
								kind: "command",
								target: "bun test",
								text: "1 fail",
								exitCode: 1,
							}),
						]}
					/>
				</ul>,
			),
		);
		const buttons = () => [...host.querySelectorAll("button")];
		const click = (text: string) =>
			act(async () =>
				buttons()
					.find((button) => button.textContent?.includes(text))
					?.click(),
			);
		expect(buttons()[0]?.textContent).toContain("Read 1 file, ran 1 command");
		const rows = host.querySelectorAll("[data-slot=machine-action]");
		expect(rows).toHaveLength(2);
		expect(rows[1]?.textContent).toContain("Exit 1");

		await click("README.md");
		expect(host.querySelectorAll("pre span")).toHaveLength(12);
		await click("Show more");
		expect(host.querySelectorAll("pre span")).toHaveLength(20);
		await click("Show full result");
		expect(host.querySelector("pre")?.textContent).toBe("the whole file");

		act(() => root.unmount());
		host.remove();
	});
});
