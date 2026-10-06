import { ChannelsConfigSchema } from "@tedix/api-contract/schemas/tedi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
const created: unknown[] = [];

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children?: ReactNode }) => (
		<a href={to}>{children}</a>
	),
	useNavigate: () => navigate,
}));
vi.mock("@/lib/tedi-permissions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tedi-permissions")>()),
	useCanCreateTedis: () => true,
}));
vi.mock("@/lib/api", () => {
	const ok = async () => ({ ok: true });
	const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
		"tedis.create": async (input) => {
			created.push(input);
			return { id: "tedi-9" };
		},
		"tedis.wake": async () => ({ ready: true, status: "running" }),
	};
	// Every other procedure resolves to an empty success.
	const client = (path: string[]): unknown =>
		new Proxy((input: unknown) => (handlers[path.join(".")] ?? ok)(input), {
			get: (_target, key) =>
				typeof key === "string" ? client([...path, key]) : undefined,
		});
	return { osApi: client([]) };
});

const { buildRuntimeModelOverrides, CreateTediPage, parseIdentifierList } =
	await import("@/components/create-tedi-page");
const { modelCatalogQueryOptions, osQueryKeys } =
	await import("@/lib/os-query-options");

function page(
	channel: "none" | "telegram",
	client = new QueryClient(),
	advanced = false,
) {
	return (
		<QueryClientProvider client={client}>
			<CreateTediPage
				channel={channel}
				advanced={advanced}
				onChannelChange={() => {}}
				onAdvancedChange={() => {}}
			/>
		</QueryClientProvider>
	);
}
const html = (channel: "none" | "telegram") =>
	renderToStaticMarkup(
		page(
			channel,
			new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
			true,
		),
	);

describe("CreateTediPage", () => {
	it("warns about Telegram privacy mode once mention-only is turned off", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		await act(async () =>
			createRoot(container).render(
				page(
					"telegram",
					new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
				),
			),
		);
		expect(container.textContent).not.toContain(
			"Telegram privacy mode required",
		);
		await act(async () => {
			container.querySelector<HTMLElement>('[role="switch"]')!.click();
		});
		// A Kumo warning Alert, not a hand-tinted box.
		const alert = [...container.querySelectorAll('[data-slot="alert"]')].find(
			(element) =>
				element.textContent?.includes("Telegram privacy mode required"),
		);
		expect(alert).toBeDefined();
		container.remove();
	});

	it("builds the runtime model override accepted by the create contract", () => {
		expect(buildRuntimeModelOverrides("anthropic/claude-sonnet-4-5")).toEqual({
			agents: {
				defaults: {
					model: { primary: "anthropic/claude-sonnet-4-5" },
				},
			},
		});
	});

	it("normalizes comma and newline separated channel identifiers", () => {
		expect(parseIdentifierList("123, 456\n789,\n")).toEqual([
			"123",
			"456",
			"789",
		]);
	});

	it("launches through the create contract and enters the Tedix OS detail route", async () => {
		const client = new QueryClient();
		client.setQueryData(modelCatalogQueryOptions().queryKey, {
			models: [
				{
					ref: "workers-ai/@cf/meta/llama",
					label: "Llama",
					allowed: true,
					selectable: true,
				},
			],
			routing: { modelRef: "workers-ai/@cf/meta/llama" },
		} as never);
		const invalidated: unknown[] = [];
		const invalidate = client.invalidateQueries.bind(client);
		client.invalidateQueries = (async (
			filters?: Parameters<typeof invalidate>[0],
		) => {
			invalidated.push(filters?.queryKey);
			return invalidate(filters);
		}) as typeof client.invalidateQueries;
		const container = document.createElement("div");
		document.body.append(container);
		await act(async () => createRoot(container).render(page("none", client)));
		const name =
			container.querySelector<HTMLInputElement>('input[name="name"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(name, "Support tedi");
			name.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container.querySelector("form")!.requestSubmit();
		});
		await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
		expect((created[0] as { name: string }).name).toBe("Support tedi");
		expect(navigate).toHaveBeenCalledWith({
			to: "/team/$tediId",
			params: { tediId: "tedi-9" },
		});
		expect(invalidated).toEqual(
			expect.arrayContaining([osQueryKeys.tedis(), osQueryKeys.tediSecrets()]),
		);
		container.remove();
	});

	it("lists denied catalog models as unavailable and never selectable", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { enabled: false } },
		});
		client.setQueryData(modelCatalogQueryOptions().queryKey, {
			models: [
				{
					ref: "workers-ai/allowed",
					label: "Allowed",
					allowed: true,
					selectable: true,
				},
				{
					ref: "azure/denied",
					label: "Denied",
					allowed: false,
					selectable: true,
				},
			],
			routing: { modelRef: "azure/denied" },
		} as never);
		const container = document.createElement("div");
		document.body.append(container);
		await act(async () => createRoot(container).render(page("none", client)));
		const trigger = [
			...container.querySelectorAll<HTMLElement>('[role="combobox"]'),
		][0]!;
		// The routed default is denied, so the picker seeds the first allowed model.
		expect(trigger.textContent).toContain("workers-ai/allowed");
		await act(async () => {
			trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			trigger.click();
		});
		const denied = [...document.querySelectorAll('[role="option"]')].find(
			(option) => option.textContent?.includes("Denied"),
		);
		expect(denied?.textContent).toContain("unavailable");
		expect(
			denied?.getAttribute("aria-disabled") === "true" ||
				denied?.hasAttribute("data-disabled"),
		).toBe(true);
		container.remove();
	});

	it("offers only implemented Tedi channels", () => {
		expect(
			ChannelsConfigSchema.safeParse({ discord: { enabled: true } }).success,
		).toBe(false);
		expect(
			ChannelsConfigSchema.safeParse({ slack: { enabled: true } }).success,
		).toBe(false);
		const telegram = html("telegram");
		expect(telegram).toContain("Telegram");
		for (const unimplemented of [
			"Discord",
			"Slack",
			"DISCORD_BOT_TOKEN",
			"SLACK_BOT_TOKEN",
		])
			expect(telegram).not.toContain(unimplemented);
	});

	it("uses the quiet single-lane launch grammar and semantic Kumo tokens", () => {
		const doc = new DOMParser().parseFromString(html("telegram"), "text/html");
		const text = doc.body.textContent ?? "";
		for (const label of [
			"Tedi name",
			"Display name",
			"Model",
			"Connection",
			"Personality",
			"Language",
			"Timezone",
		])
			expect(text).toContain(label);
		expect(doc.querySelector('input[name="name"]')).not.toBeNull();
		expect(doc.querySelector('input[name="displayName"]')).not.toBeNull();
		expect(doc.querySelector("form")?.classList.contains("min-w-0")).toBe(true);
		expect(
			doc.querySelector('[aria-labelledby="launch-readiness-title"]'),
		).not.toBeNull();
		expect(text).toContain("Ready to launch?");
		expect(text).not.toContain("Launch Summary");
		const markup = doc.body.innerHTML;
		for (const legacyToken of [
			"lg:grid-cols-[1.5fr_1fr]",
			"text-muted-foreground",
			"text-foreground",
			"text-primary",
			"text-destructive",
			"border-destructive",
			"hover:bg-muted",
		])
			expect(markup).not.toContain(legacyToken);
	});
});
