import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Organization } from "@tedix/api-contract/schemas/organization";
import { defaultTediWidgetConfig } from "@/lib/tedi-widget-config";
const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { organizations: api } }));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		tedis: {
			list: {
				queryOptions: () => ({
					queryKey: ["test-tedis"],
					queryFn: async () => ({ data: [] }),
				}),
			},
		},
	},
	organizationDetailQueryOptions: (id: string) => ({
		queryKey: ["organization", id],
	}),
}));
import {
	ExperienceEditor,
	mergeExperienceDraft,
} from "./widget-experience-editor";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
	cleanups.splice(0).forEach((fn) => fn());
	vi.restoreAllMocks();
	vi.resetAllMocks();
});
const base = defaultTediWidgetConfig({ name: "Acme" });
const organization = {
	id: "org",
	name: "Acme",
	metadata: { tediWidget: base },
} as Organization;
async function mount(config = base, showPreview = true) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (next = config) =>
		act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<ExperienceEditor organization={organization} config={next} />
				</QueryClientProvider>,
			);
		});
	await render();
	if (showPreview)
		await act(async () => {
			Array.from(host.querySelectorAll("button"))
				.find((button) => button.textContent === "Preview")
				?.click();
		});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
		client.clear();
	});
	const button = (label: string) =>
		Array.from(host.querySelectorAll("button")).find(
			(el) => el.textContent === label,
		)!;
	const change = async (label: string, value: string) => {
		const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			`[aria-label="${label}"]`,
		)!;
		await act(async () => {
			const proto =
				input.tagName === "TEXTAREA"
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	return { host, render, button, change };
}
async function waitForRender(predicate: () => boolean) {
	for (let attempt = 0; attempt < 50 && !predicate(); attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 2));
		});
	}
	expect(predicate()).toBe(true);
}

it("previews all draft questions, rejects excess without truncation and discards edits", async () => {
	const { host, button, change } = await mount();
	expect(host.textContent).toContain("Appearance");
	expect(host.textContent).toContain("Welcome");
	expect(host.textContent).toContain("Behavior");
	expect(host.querySelector('[aria-label="Full chat path"]')).toBeNull();
	expect(host.querySelector('[aria-label="Home modules"]')).toBeNull();
	expect(host.querySelector('[aria-label="Assistant logo URL"]')).toBeNull();
	expect(button("Publish changes").disabled).toBe(true);
	await change(
		"Suggested questions",
		"One\nTwo\nThree\nFour\nFive\nSix\nSeven",
	);
	expect(host.querySelector('[aria-label="Preview"]')!.textContent).toContain(
		"Seven",
	);
	expect(host.querySelector('[role="alert"]')).not.toBeNull();
	expect(button("Publish changes").disabled).toBe(true);
	await act(async () => button("Discard draft").click());
	expect(button("Publish changes").disabled).toBe(true);
	expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("preserves drafts across refresh and failed publish, then reports saved state", async () => {
	const { host, render, change, button } = await mount();
	await change("Assistant name", "Helper");
	await render({ ...base, analyticsEnabled: true });
	expect(
		(host.querySelector('[aria-label="Assistant name"]') as HTMLInputElement)
			.value,
	).toBe("Helper");
	api.get.mockResolvedValue({
		...organization,
		metadata: { tediWidget: { ...base, analyticsEnabled: true } },
	});
	let reject!: (error: Error) => void;
	api.update.mockImplementationOnce(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	await act(async () => button("Publish changes").click());
	await waitForRender(() => host.querySelector("fieldset")?.disabled === true);
	expect(host.querySelector("fieldset")?.disabled).toBe(true);
	await act(async () => {
		reject(new Error("Connection interrupted"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await waitForRender(
		() =>
			host
				.querySelector('[role="alert"]')
				?.textContent?.includes("Connection interrupted") === true,
	);
	expect(host.querySelector('[role="alert"]')?.textContent).toContain(
		"Connection interrupted",
	);
	expect(
		(host.querySelector('[aria-label="Assistant name"]') as HTMLInputElement)
			.value,
	).toBe("Helper");
	api.update.mockImplementation(async (input) => ({
		...organization,
		metadata: input.metadata,
	}));
	await act(async () => {
		button("Publish changes").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(api.update.mock.calls.at(-1)?.[0].metadata.tediWidget).toMatchObject({
		title: "Helper",
		analyticsEnabled: true,
	});
	await waitForRender(() => host.textContent?.includes("Published") === true);
	expect(host.textContent).toContain("Published");
	expect(button("Publish changes").disabled).toBe(true);
});
it("edits effective locale overrides and previews language and theme", async () => {
	const config = {
		...base,
		locale: "es-MX",
		translations: { es: { title: "Ayuda", welcomeHeading: "Bienvenido" } },
		conversationStarters: ["Revisar orden"],
	};
	const { host, change, button } = await mount(config);
	expect(
		(host.querySelector('[aria-label="Assistant name"]') as HTMLInputElement)
			.value,
	).toBe("Ayuda");
	await change("Assistant name", "Mi asistente");
	const preview = host.querySelector('[aria-label="Preview"]')!;
	expect(preview.textContent).toContain("Mi asistente");
	expect(preview.textContent).toContain("Bienvenido");
	expect(preview.textContent).toContain("Revisar orden");
	await act(async () => button("Show dark").click());
	expect(preview.querySelector('[data-mode="dark"]')).not.toBeNull();
});
it("preserves unrelated fresh fields and rejects observed same-field conflicts", () => {
	expect(
		mergeExperienceDraft(
			base,
			{ ...base, title: "New" },
			{ ...base, analyticsEnabled: true },
		),
	).toMatchObject({ title: "New", analyticsEnabled: true });
	expect(() =>
		mergeExperienceDraft(
			base,
			{ ...base, title: "New" },
			{ ...base, title: "Another editor" },
		),
	).toThrow("changed while you were editing");
});

it("previews runtime starter defaults, hides disabled modules and reflects opening mode and artwork", async () => {
	const config = {
		...base,
		locale: "es",
		conversationStarters: [],
		homeModules: [] as NonNullable<typeof base.homeModules>,
		launcherPosition: "bottom-left" as const,
		assistantLogoUrl: "https://example.com/light.png",
		assistantLogoUrlDark: "https://example.com/dark.png",
	};
	const { host, render, button } = await mount(config);
	const preview = host.querySelector('[aria-label="Preview"]')!;
	expect(preview.textContent).toContain("¿Qué necesita atención hoy?");
	expect(preview.textContent).not.toContain("¿Cómo puedo ayudarte");
	expect(
		preview.querySelector('[aria-label="Preview launcher"]')?.className,
	).toContain("left-3");
	await act(async () => button("Show dark").click());
	expect(
		preview.querySelector('img[alt="Assistant logo"]')?.getAttribute("src"),
	).toBe("https://example.com/dark.png");
	await render({
		...config,
		startMode: "conversation",
		launcherMode: "hidden",
	});
	expect(preview.textContent).not.toContain("¿Qué necesita atención hoy?");
	expect(preview.querySelector('[aria-label="Preview launcher"]')).toBeNull();
});

it("merges a new localized welcome without overwriting concurrently published locales", () => {
	const next = mergeExperienceDraft(
		base,
		{ ...base, translations: { en: { welcomeHeading: "Welcome" } } },
		{ ...base, translations: { es: { welcomeHeading: "Hola" } } },
	);
	expect(next.translations).toMatchObject({
		en: { welcomeHeading: "Welcome" },
		es: { welcomeHeading: "Hola" },
	});
});

it("renders an existing non-Intl locale without crashing", async () => {
	const { host } = await mount({ ...base, locale: "en-12" });
	expect(host.textContent).toContain("en-12");
});

it("keeps the preview collapsed on a narrow screen until requested", async () => {
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	} as unknown as MediaQueryList);
	const { host, button } = await mount(base, false);
	expect(host.querySelector('[aria-label="Assistant name"]')).not.toBeNull();
	expect(host.querySelector('[aria-label="Preview"]')).toBeNull();
	expect(button("Preview").getAttribute("aria-expanded")).toBe("false");
	await act(async () => button("Preview").click());
	expect(host.querySelector('[aria-label="Preview"]')).not.toBeNull();
});
it("isolates preview surface and ink colors from an opposite OS theme", async () => {
	const { host, button } = await mount();
	const canvas = host.querySelector<HTMLElement>('[data-mode="light"]')!;
	expect(canvas.style.getPropertyValue("--color-kumo-base")).toBe("#ffffff");
	expect(canvas.style.getPropertyValue("--text-color-kumo-default")).toBe(
		"#18181b",
	);
	await act(async () => button("Show dark").click());
	expect(canvas.style.getPropertyValue("--color-kumo-base")).toBe("#242424");
	expect(canvas.style.getPropertyValue("--text-color-kumo-default")).toBe(
		"#f4f4f5",
	);
});
it("uses actionable field labels for invalid colors", async () => {
	const { host, change } = await mount();
	await change("Brand color", "invalid");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain(
		"Brand color: enter a six-digit hex color such as #1594c7.",
	);
	expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(
		"accentColor:",
	);
});

it("publishes both hourly turn limits under tediWidget.turnQuota", async () => {
	const { host, change, button } = await mount();
	const visitor = host.querySelector<HTMLInputElement>(
		'[aria-label="Turns per visitor per hour"]',
	)!;
	expect(visitor.placeholder).toBe("60");
	expect(
		host.querySelector<HTMLInputElement>(
			'[aria-label="Turns per website per hour"]',
		)!.placeholder,
	).toBe("600");
	expect(host.textContent).toContain("Leave empty for the default.");
	api.get.mockResolvedValue(organization);
	api.update.mockImplementation(async (input) => ({
		...organization,
		metadata: input.metadata,
	}));
	await change("Turns per visitor per hour", "20");
	await change("Turns per website per hour", "300");
	expect(host.querySelector('[role="alert"]')).toBeNull();
	expect(button("Publish changes").disabled).toBe(false);
	await act(async () => {
		button("Publish changes").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(
		api.update.mock.calls.at(-1)?.[0].metadata.tediWidget.turnQuota,
	).toEqual({ visitorTurnsPerHour: 20, originTurnsPerHour: 300 });
});

it("drops the turnQuota key when both limits are cleared", async () => {
	const config = {
		...base,
		turnQuota: { visitorTurnsPerHour: 20, originTurnsPerHour: 300 },
	};
	const { host, change, button } = await mount(config);
	api.get.mockResolvedValue({
		...organization,
		metadata: { tediWidget: config },
	});
	api.update.mockImplementation(async (input) => ({
		...organization,
		metadata: input.metadata,
	}));
	await change("Turns per visitor per hour", "");
	await change("Turns per website per hour", "");
	expect(button("Publish changes").disabled).toBe(false);
	await act(async () => {
		button("Publish changes").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const published = api.update.mock.calls.at(-1)?.[0].metadata.tediWidget;
	expect("turnQuota" in published).toBe(false);
	expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("blocks publishing an out-of-range or fractional turn limit", async () => {
	const { host, change, button } = await mount();
	await change("Turns per visitor per hour", "0");
	expect(button("Publish changes").disabled).toBe(true);
	expect(host.querySelector('[role="alert"]')?.textContent).toContain(
		"Turns per visitor per hour: enter a whole number from 1 to 10,000",
	);
	await change("Turns per visitor per hour", "30");
	await change("Turns per website per hour", "100001");
	expect(button("Publish changes").disabled).toBe(true);
	expect(host.querySelector('[role="alert"]')?.textContent).toContain(
		"Turns per website per hour: enter a whole number from 1 to 100,000",
	);
	await change("Turns per website per hour", "2.5");
	expect(button("Publish changes").disabled).toBe(true);
	await change("Turns per website per hour", "");
	expect(button("Publish changes").disabled).toBe(false);
});
