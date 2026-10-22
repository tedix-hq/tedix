import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveChannelsForm, liveChannelValues } from "./tedi-settings-channels";
import {
	IdentitySettingsForm,
	RepositorySettingsForm,
	GovernanceSettingsForm,
	SecretSettingsForm,
	CustomDomainForm,
	AppAssignmentForm,
	ModelSettingsForm,
	SettingsRecordRow,
	SettingsSection,
} from "./tedi-settings-forms";

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

async function renderForm(element: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	await act(async () => root.render(element));
	return container;
}

function inputFor(container: HTMLElement, label: string) {
	const element = Array.from(container.querySelectorAll("label")).find((el) =>
		el.textContent?.startsWith(label),
	);
	return document.getElementById(element!.htmlFor) as HTMLInputElement;
}

async function fill(input: HTMLInputElement, value: string) {
	await act(async () => {
		const prototype =
			input.tagName === "TEXTAREA"
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
			input,
			value,
		);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function submit(container: HTMLElement) {
	await act(async () => {
		container
			.querySelector("form")!
			.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

describe("Tedi settings forms", () => {
	it("submits identity fields with their schema transformations", async () => {
		const onSave = vi.fn();
		const container = await renderForm(
			<IdentitySettingsForm
				values={{
					displayName: "Test assistant",
					personality: "Calm",
					language: "en",
					timezone: "UTC",
				}}
				disabled={false}
				onSave={onSave}
			/>,
		);
		await fill(inputFor(container, "Display name"), "  Sample assistant  ");
		await submit(container);
		expect(onSave).toHaveBeenCalledWith({
			displayName: "Sample assistant",
			personality: "Calm",
			language: "en",
			timezone: "UTC",
		});
	});
	it("rejects a malformed repository URL", async () => {
		const onSave = vi.fn();
		const container = await renderForm(
			<RepositorySettingsForm
				values={{ repoUrl: "", repoBranch: "main" }}
				disabled={false}
				onSave={onSave}
			/>,
		);
		await fill(inputFor(container, "Repository URL"), "invalid-url");
		await submit(container);
		expect(onSave).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Enter a valid repository URL.");
	});
	it("keeps invalid policy JSON from being saved", async () => {
		const onSave = vi.fn();
		const container = await renderForm(
			<GovernanceSettingsForm
				values={{
					toolPolicyJson: "{}",
					learningPolicyJson: "{}",
					budgetsJson: "{}",
					quietHoursJson: "{}",
				}}
				disabled={false}
				onSave={onSave}
			/>,
		);
		await fill(inputFor(container, "Tool policy"), "{");
		await submit(container);
		expect(onSave).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Tool policy must be valid JSON.");
	});
	it.each([true, false])(
		"clears a secret only after a successful save (%s)",
		async (success) => {
			const onSave = vi.fn().mockResolvedValue(success);
			const container = await renderForm(
				<SecretSettingsForm disabled={false} onSave={onSave} />,
			);
			await fill(inputFor(container, "Secret value"), "fictional-test-token");
			await submit(container);
			expect(onSave).toHaveBeenCalledWith({
				name: "GITHUB_PAT",
				value: "fictional-test-token",
			});
			expect(inputFor(container, "Secret value").value).toBe(
				success ? "" : "fictional-test-token",
			);
		},
	);
	it("normalizes a domain and clears it after saving", async () => {
		const onSave = vi.fn().mockResolvedValue(true);
		const container = await renderForm(
			<CustomDomainForm disabled={false} onSave={onSave} />,
		);
		await fill(inputFor(container, "Custom hostname"), "ASSISTANT.EXAMPLE.COM");
		await submit(container);
		expect(onSave).toHaveBeenCalledWith({ hostname: "assistant.example.com" });
		expect(inputFor(container, "Custom hostname").value).toBe("");
	});
	it("requires an app before submitting an assignment", async () => {
		const onSave = vi.fn();
		const container = await renderForm(
			<AppAssignmentForm apps={[]} disabled={false} onSave={onSave} />,
		);
		await submit(container);
		expect(onSave).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Choose an app.");
	});
	it("labels the automatic model Auto and submits its unchanged reference", async () => {
		const onSave = vi.fn();
		const container = await renderForm(
			<ModelSettingsForm
				value="cloudflare/auto"
				models={[
					{
						ref: "cloudflare/auto",
						label: "Cloudflare Auto",
						allowed: true,
						selectable: true,
					},
				]}
				disabled={false}
				onSave={onSave}
			/>,
		);
		expect(inputFor(container, "Primary model").textContent).toBe("Auto");
		await submit(container);
		expect(onSave).toHaveBeenCalledWith({ model: "cloudflare/auto" });
	});
	it("keeps record content and actions inside their shared settings row", async () => {
		const container = await renderForm(
			<SettingsSection title="Devices">
				<ul>
					<SettingsRecordRow
						title="Test workstation"
						description="Pending"
						trailing={<button>Approve</button>}
					/>
				</ul>
			</SettingsSection>,
		);
		expect(container.querySelector("h2")?.textContent).toBe("Devices");
		const row = container.querySelector('li [data-slot="setting-row"]');
		expect(row?.textContent).toContain("Pending");
		expect(row?.querySelector("button")?.textContent).toBe("Approve");
	});
});
