import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveChannelsForm, liveChannelValues } from "./tedi-settings-channels";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openDirectMessages(dmPolicy?: string) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	await act(async () => {
		root.render(
			<LiveChannelsForm
				values={liveChannelValues({ telegram: { dmPolicy } })}
				canManage
				canReadSecrets
				canManageSecrets
				isSaving={false}
				isTesting={false}
				onSave={vi.fn().mockResolvedValue(true)}
				onTest={vi.fn()}
			/>,
		);
	});
	const label = Array.from(container.querySelectorAll("label")).find(
		(element) => element.textContent === "Direct messages",
	);
	const trigger = document.getElementById(label!.htmlFor)!;
	await act(async () => {
		trigger.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: 0 }),
		);
		trigger.click();
	});
	return {
		trigger,
		options: Array.from(document.querySelectorAll('[role="option"]')).map(
			(option) => option.textContent,
		),
	};
}

describe("Telegram DM pairing visibility", () => {
	it.each([undefined, "allowlist", "open", "disabled"])(
		"hides pairing when the stored policy is %s",
		async (policy) => {
			const { options } = await openDirectMessages(policy);
			expect(options).toEqual(["Allowlist", "Open", "Disabled"]);
		},
	);

	it("still renders the stored pairing policy and its option", async () => {
		const { trigger, options } = await openDirectMessages("pairing");
		expect(trigger.textContent).toContain(
			"Allowlist (pairing not yet available)",
		);
		expect(options).toEqual([
			"Allowlist (pairing not yet available)",
			"Allowlist",
			"Open",
			"Disabled",
		]);
	});
});
