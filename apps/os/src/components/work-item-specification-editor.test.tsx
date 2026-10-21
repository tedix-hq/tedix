import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { WorkItemSpecificationEditor } from "./work-item-specification-editor";

const { updateSpecification } = vi.hoisted(() => ({
	updateSpecification: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: { workItems: { updateSpecification } },
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item: WorkItem = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "22222222-2222-4222-8222-222222222222",
	title: "Review Cedar launch",
	description: "Keep the launch evidence together.",
	priority: "high",
	version: 37,
	disposition: "accepted",
	workKind: "coding",
	riskLevel: "medium",
	acceptanceContract: null,
	requiredCapabilities: [],
	requiredAuthorities: [],
	objectiveId: null,
	workClass: null,
	purposeExceptionExpiresAt: null,
	projectId: null,
	parentWorkItemId: null,
	sourceSessionKey: null,
	sourceIntentId: null,
	accountableOwnerType: null,
	accountableOwnerId: null,
	stewardType: null,
	stewardId: null,
	reviewerType: null,
	reviewerId: null,
	reviewerLeaseExpiresAt: null,
	dueDate: null,
	deadline: null,
	startAt: null,
	durationDays: null,
	provenance: null,
	metadata: null,
	admissionSpecRevision: "cedar-specification-v37",
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: null,
	acceptedAt: null,
	completedAt: null,
	cancelledAt: null,
};

const mounts: { root: Root; host: HTMLDivElement; client: QueryClient }[] = [];
afterEach(() => {
	for (const { root, host, client } of mounts.splice(0)) {
		act(() => root.unmount());
		host.remove();
		client.clear();
	}
	vi.restoreAllMocks();
	updateSpecification.mockReset();
});

async function mount(value = item) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	mounts.push({ root, host, client });
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<WorkItemSpecificationEditor item={value} />
			</QueryClientProvider>,
		);
	});
	await act(async () => host.querySelector("button")!.click());
	return {
		host,
		client,
		title: host.querySelector("input")!,
		description: host.querySelector("textarea")!,
		priority: host.querySelector<HTMLButtonElement>('[role="combobox"]')!,
		submit: host.querySelector<HTMLButtonElement>('button[type="submit"]')!,
	};
}

async function edit(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	await act(async () => {
		const prototype =
			field instanceof HTMLInputElement
				? HTMLInputElement.prototype
				: HTMLTextAreaElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
			field,
			value,
		);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function submit(host: HTMLElement) {
	await act(async () => {
		host
			.querySelector("form")!
			.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

it("names each field from one visible label reference without fresh-render warnings", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const first = await mount();
	const second = await mount({
		...item,
		id: "33333333-3333-4333-8333-333333333333",
	});
	for (const { host, title, description, priority } of [first, second]) {
		for (const [field, name] of [
			[title, "Title"],
			[description, "Description"],
			[priority, "Priority"],
		] as const) {
			const reference = field.getAttribute("aria-labelledby");
			expect(reference).toBeTruthy();
			const matches = [...document.querySelectorAll("[id]")].filter(
				(element) => element.id === reference,
			);
			expect(matches).toHaveLength(1);
			expect(matches[0]!.textContent).toBe(name);
			const label = matches[0]!.closest("label");
			expect(label?.htmlFor).toBe(field.id);
			expect(host.querySelector(`[id="${field.id}"]`)).toBe(field);
		}
	}
	expect(
		warn.mock.calls.filter(([message]) =>
			String(message).includes("accessible name"),
		),
	).toEqual([]);
});

it("saves a trimmed title with the exact loaded Work version and reports success", async () => {
	updateSpecification.mockResolvedValue({ ...item, version: 38 });
	const view = await mount();
	const invalidate = vi.spyOn(view.client, "invalidateQueries");
	await edit(view.title, "  Review Cedar evidence  ");
	await edit(
		view.description,
		"  Preserve description whitespace.\nSecond line.  ",
	);
	await submit(view.host);
	expect(updateSpecification).toHaveBeenCalledExactlyOnceWith({
		id: item.id,
		title: "Review Cedar evidence",
		description: "  Preserve description whitespace.\nSecond line.  ",
		priority: "high",
		expectedWorkItemVersion: 37,
	});
	expect(invalidate).toHaveBeenCalledExactlyOnceWith({
		queryKey: osQuery.workItems.key({ type: "query" }),
	});
	expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toBe(
		"Task details saved.",
	);
});

it.each(["", "   "])(
	"rejects an empty trimmed title %j even on form submission",
	async (title) => {
		const view = await mount();
		await edit(view.title, title);
		expect(view.submit.disabled).toBe(true);
		await submit(view.host);
		expect(updateSpecification).not.toHaveBeenCalled();
	},
);

it("disables fields and prevents duplicate submissions while a save is pending", async () => {
	let finish!: (value: WorkItem) => void;
	updateSpecification.mockImplementation(
		() =>
			new Promise<WorkItem>((resolve) => {
				finish = resolve;
			}),
	);
	const view = await mount();
	await submit(view.host);
	for (const control of [
		view.title,
		view.description,
		view.priority,
		view.submit,
	]) {
		expect(control.disabled).toBe(true);
	}
	expect(view.submit.textContent).toBe("Saving…");
	await submit(view.host);
	expect(updateSpecification).toHaveBeenCalledTimes(1);
	await act(async () => {
		finish(item);
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	expect(view.submit.disabled).toBe(false);
});

it.each(["Access denied", "Conflict: Work Item version changed"])(
	"retains the draft after %s and retries with the loaded version",
	async (message) => {
		updateSpecification.mockRejectedValueOnce(new Error(message));
		const view = await mount({ ...item, description: null });
		expect(view.description.value).toBe("");
		await edit(view.title, "  Unsaved Cedar title  ");
		await edit(view.description, "Unsaved description\nwith detail");
		await submit(view.host);
		expect(view.title.value).toBe("  Unsaved Cedar title  ");
		expect(view.description.value).toBe("Unsaved description\nwith detail");
		expect(view.priority.textContent).toContain("high");
		expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
			message,
		);
		expect(view.host.querySelector('[aria-live="polite"]')).toBeNull();
		expect(view.submit.disabled).toBe(false);
		updateSpecification.mockResolvedValueOnce({ ...item, version: 38 });
		await submit(view.host);
		expect(updateSpecification).toHaveBeenCalledTimes(2);
		expect(updateSpecification.mock.calls[1]![0]).toEqual(
			updateSpecification.mock.calls[0]![0],
		);
		expect(updateSpecification.mock.calls[1]![0].expectedWorkItemVersion).toBe(
			37,
		);
		expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toBe(
			"Task details saved.",
		);
	},
);
