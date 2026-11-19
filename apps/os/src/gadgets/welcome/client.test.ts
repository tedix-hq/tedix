import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import kit from "../../../../../plugins/tedix/skills/tedix-build-app/assets/ui-kit.js?raw";
import client from "./client.js?raw";

async function mount(
	models = [{ ref: "azure-openai/example", label: "Example" }],
	modelRef: string | null = null,
) {
	document.body.innerHTML = '<div id="app"></div>';
	const call = vi.fn(async (method: string): Promise<unknown> =>
		method === "welcome.config"
			? {
					name: "Alex",
					email: "alex@example.com",
					organization: "Sample team",
					models,
					modelRef,
				}
			: null,
	);
	new Function("tedix", `${kit}\n${client}`)({ call });
	await vi.waitFor(() =>
		expect(document.querySelector("h2")?.textContent).toBe("Your profile"),
	);
	return call;
}
async function click(label: string) {
	const button = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === label,
	)!;
	button.click();
	await vi.waitFor(() =>
		expect(
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent === "Saving…",
			),
		).toBe(false),
	);
}
afterEach(() => {
	document.body.replaceChildren();
	document.head.replaceChildren();
});

describe("welcome gadget", () => {
	it("saves a profile and model, explains connections and tasks, then finishes", async () => {
		const call = await mount();
		const input = document.querySelector("input")!;
		input.value = "Alex Smith";
		input.dispatchEvent(new Event("input"));
		await click("Next");
		expect(call).toHaveBeenCalledWith("welcome.profile", {
			name: "Alex Smith",
		});
		const select = document.querySelector("select")!;
		select.value = "azure-openai/example";
		select.dispatchEvent(new Event("change"));
		await click("Next");
		expect(call).toHaveBeenCalledWith("welcome.model", {
			ref: "azure-openai/example",
		});
		expect(document.body.textContent).toContain(
			"Sign-in and consent stay with you",
		);
		await click("Next");
		expect(document.body.textContent).toContain("research a topic");
		await click("Ask your first question");
		expect(call).toHaveBeenCalledWith("welcome.complete");
	});
	it("allows the organization default without an empty model picker", async () => {
		const call = await mount([]);
		await click("Next");
		expect(document.querySelector("select")).toBeNull();
		expect(document.body.textContent).toContain("Use the organization default");
		await click("Next");
		expect(call).not.toHaveBeenCalledWith("welcome.model", expect.anything());
	});
	it("keeps a previous model that is no longer offered until the person changes it", async () => {
		const call = await mount(undefined, "azure-openai/previous");
		await click("Next");
		expect(document.querySelector("select")?.value).toBe(
			"azure-openai/previous",
		);
		await click("Next");
		expect(call).not.toHaveBeenCalledWith("welcome.model", expect.anything());
		await click("Back");
		const select = document.querySelector("select")!;
		select.value = "";
		select.dispatchEvent(new Event("change"));
		await click("Next");
		expect(call).toHaveBeenCalledWith("welcome.model", { ref: null });
	});

	it("keeps the current step and the name after a failed save", async () => {
		const call = await mount();
		call.mockRejectedValueOnce(new Error("Profile changed; try again"));
		const input = document.querySelector("input")!;
		input.value = "New name";
		input.dispatchEvent(new Event("input"));
		await click("Next");
		expect(document.querySelector("h2")?.textContent).toBe("Your profile");
		expect(document.querySelector("input")?.value).toBe("New name");
		expect(document.body.textContent).toContain("Profile changed; try again");
		expect(call).not.toHaveBeenCalledWith("welcome.complete");
	});
});
