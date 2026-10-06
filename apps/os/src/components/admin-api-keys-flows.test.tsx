/**
 * API-key management, mounted. The dialog offers exactly the scopes the
 * server accepts and starts from least privilege; every destructive or
 * invalidating action confirms first; creation and rotation carry the
 * stepped-up token as a mutation argument through the direct-to-API client
 * (the OS `/api` proxy strips Authorization), and the step-up intent that
 * survives a redirect carries no secret.
 */
import {
	API_KEY_SCOPE_METADATA,
	PLATFORM_ONLY_API_KEY_SCOPES,
	TENANT_DELEGABLE_API_KEY_SCOPES,
} from "@tedix/api-contract/schemas/organization";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
	calls: [] as Array<{ client: string; path: string; input: unknown }>,
	stepUpHooks: [] as Array<Record<string, unknown>>,
	stepUpIntents: [] as unknown[],
	resume: {} as Record<string, { intent: unknown; failure: string | null }>,
	webMcp: [] as string[],
	webMcpFactories: [] as Array<() => unknown>,
	// When set, revoke/delete calls return this result instead of resolving.
	destructiveResult: null as (() => Promise<unknown>) | null,
}));
vi.mock("@/lib/api", () => {
	const client = (label: string, path: string[]): unknown =>
		new Proxy(
			(input: unknown) => {
				const key = path.join(".");
				h.calls.push({ client: label, path: key, input });
				if (key.endsWith("createApiKey") || key.endsWith("rotateApiKey"))
					return Promise.resolve({
						rawKey: "sk_live_raw",
						apiKey: { name: "CI" },
					});
				if (
					h.destructiveResult &&
					(key.endsWith("revokeApiKey") || key.endsWith("deleteApiKey"))
				)
					return h.destructiveResult();
				return Promise.resolve({ data: [], pagination: { total: 0 } });
			},
			{
				get: (_target, name) =>
					typeof name === "string" ? client(label, [...path, name]) : undefined,
			},
		);
	return {
		osApi: client("proxy", []),
		getAuthenticatedOsApi: (token: string) => client(`direct:${token}`, []),
	};
});
vi.mock("@/lib/step-up-auth", () => ({
	useStepUpAuth: (options: Record<string, unknown>) => {
		h.stepUpHooks.push(options);
		return {
			requireStepUp: (run: (token: string) => void, intent?: unknown) => {
				h.stepUpIntents.push(intent);
				run("su-token");
			},
			StepUpDialog: () => null,
		};
	},
	useStepUpResume: ({ key }: { key: string }) =>
		h.resume[key] ?? { intent: null, failure: null },
}));
vi.mock("@/lib/webmcp/use-webmcp-tools", () => ({
	useWebMcpTools: (namespace: string, factory: () => unknown) => {
		h.webMcp.push(namespace);
		h.webMcpFactories.push(factory);
	},
}));

const {
	AdminApiKeysPage,
	CREATE_API_KEY_STEP_UP_INTENT,
	DEFAULT_KEY_SCOPES,
	ROTATE_API_KEY_STEP_UP_INTENT,
} = await import("./admin-api-keys-page");
const q = await import("@/lib/os-query-options");
const { Page } = await import("@/components/kumo/page");

const ORG = "org-1";
const KEY = {
	id: "key-1",
	name: "CI",
	keyPrefix: "sk_live_ab",
	status: "active",
	environment: "live",
	scopes: ["apps:read"],
	createdAt: "2026-08-01T00:00:00.000Z",
	lastUsedAt: null,
	expiresAt: null,
};

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const unmount of unmounts.splice(0)) act(() => unmount());
	h.calls.length = 0;
	h.stepUpHooks.length = 0;
	h.stepUpIntents.length = 0;
	h.resume = {};
	h.webMcp.length = 0;
	h.webMcpFactories.length = 0;
	h.destructiveResult = null;
	document.body.replaceChildren();
});

async function mount(
	options: { page?: number; keys?: unknown[]; pendingContext?: boolean } = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				enabled: false,
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
			mutations: { retry: false },
		},
	});
	const page = options.page ?? 1;
	if (!options.pendingContext)
		client.setQueryData(q.operationalContextQueryOptions().queryKey, {
			organization: { id: ORG, descopeTenantId: "descope-tenant-1" },
			authority: { role: "owner", permissions: [] },
		} as never);
	client.setQueryData(
		q.apiKeyListQueryOptions({
			organizationId: ORG,
			limit: q.API_KEYS_PAGE_SIZE,
			offset: (page - 1) * q.API_KEYS_PAGE_SIZE,
		}).queryKey,
		{
			data: options.keys ?? [KEY],
			pagination: {
				total: (options.keys ?? [KEY]).length,
				limit: q.API_KEYS_PAGE_SIZE,
				offset: 0,
			},
		} as never,
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	unmounts.push(() => root.unmount());
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AdminApiKeysPage page={page} onPageChange={() => {}} />
			</QueryClientProvider>,
		),
	);
	const button = (text: string) =>
		[...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => candidate.textContent?.trim() === text,
		);
	const click = async (element: HTMLElement | undefined) => {
		if (!element) throw new Error("missing control");
		await act(async () => {
			element.click();
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	return { host, button, click };
}

const kumoClass = (element: ReactElement) =>
	new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html")
		.body.firstElementChild?.className;

async function openMenu(page: Awaited<ReturnType<typeof mount>>, item: string) {
	const trigger = page.host.querySelector<HTMLElement>(
		'[aria-label="API key actions for CI"]',
	)!;
	await act(async () => {
		trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		trigger.click();
	});
	const entry = [
		...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((candidate) => candidate.textContent?.trim() === item);
	await page.click(entry);
}

describe("API key operational ledger", () => {
	it("uses the wide operational-table lane and a pending surface inside the section", async () => {
		const pending = await mount({ pendingContext: true });
		expect(pending.host.querySelector('[data-slot="page"]')?.className).toBe(
			kumoClass(<Page width="xl" />),
		);
		const loading = pending.host.querySelector(
			'[aria-label="Loading API keys"]',
		);
		expect(loading?.getAttribute("aria-busy")).toBe("true");
		expect(
			loading?.querySelector('[data-slot="surface"][data-tier="panel"]'),
		).not.toBeNull();
		expect(h.webMcp).toEqual([]);
	});

	it("projects keys into one ledger surface with a contained collection below lg", async () => {
		const page = await mount();
		const ledger = page.host.querySelector(
			'[aria-labelledby="api-key-list-title"]',
		)!;
		expect(ledger.querySelector('[data-slot="card"]')).toBeNull();
		expect(
			ledger.querySelector('[data-slot="surface"][data-tier="panel"]'),
		).not.toBeNull();
		const collection = ledger.querySelector('[aria-label="API keys"]');
		expect(collection?.className).toContain("lg:hidden");
		expect(ledger.querySelector(".max-lg\\:hidden")).not.toBeNull();
		// Section actions stay touch-safe on phones.
		expect(page.button("Create key")?.className).toContain("max-sm:min-h-11");
		// Browser tools mount only inside the organization-bound body.
		expect(h.webMcp).toContain("api-keys");
	});

	it("paginates through the contract offset from the route page", async () => {
		const page = await mount({
			page: 2,
			keys: [{ ...KEY, name: "Page two key" }],
		});
		expect(page.host.textContent).toContain("Page two key");
	});
});

describe("API key creation", () => {
	it("offers the server's delegable scopes, starts least-privilege, and refuses an empty key", async () => {
		const page = await mount();
		await page.click(page.button("Create key"));
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		const text = dialog.textContent ?? "";
		for (const scope of TENANT_DELEGABLE_API_KEY_SCOPES)
			expect(text).toContain(API_KEY_SCOPE_METADATA[scope].label);
		for (const scope of PLATFORM_ONLY_API_KEY_SCOPES)
			expect(
				TENANT_DELEGABLE_API_KEY_SCOPES as readonly string[],
			).not.toContain(scope);
		const checked = [
			...dialog.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
		];
		expect(checked).toHaveLength(DEFAULT_KEY_SCOPES.length);

		// Clearing every scope disables the summary step.
		for (const box of checked) {
			const input = box.parentElement!.querySelector("input")!;
			await act(async () => input.click());
		}
		expect(page.button("Continue to summary")?.disabled).toBe(true);
	});

	it("reviews the summary, then issues the key through step-up on the direct client", async () => {
		const page = await mount();
		await page.click(page.button("Create key"));
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		const name = dialog.querySelector<HTMLInputElement>('input[name="name"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(name, "CI");
			name.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(dialog.textContent).toContain("Comma-separated CIDR ranges.");
		expect(dialog.querySelector('input[type="date"]')).toBeNull();
		await page.click(page.button("Continue to summary"));
		expect(document.body.textContent).toContain("Review token summary");
		expect(page.button("Edit token")).toBeDefined();
		await page.click(page.button("Create token"));

		const created = h.calls.find(
			(call) => call.path === "organizations.createApiKey",
		)!;
		expect(created.client).toBe("direct:su-token");
		const input = created.input as Record<string, unknown>;
		expect(input.organizationId).toBe(ORG);
		expect(input.scopes).toEqual([...DEFAULT_KEY_SCOPES]);
		expect(input.scopes).not.toContain("*");
		for (const field of ["ipAllowlist", "expiresAt", "rotationScheduleDays"])
			expect(input).toHaveProperty(field);
		// The redirect-surviving intent carries the draft, never a token.
		expect(JSON.stringify(h.stepUpIntents)).not.toMatch(
			/su-token|rawKey|secret/,
		);
		expect(document.body.textContent).toContain("sk_live_raw");
	});
});

describe("API key destructive-action safety", () => {
	it("confirms before revoking and deleting", async () => {
		for (const [item, path] of [
			["Revoke", "organizations.revokeApiKey"],
			["Delete", "organizations.deleteApiKey"],
		] as const) {
			const page = await mount();
			await openMenu(page, item);
			expect(document.body.textContent).toContain(`${item} CI?`);
			expect(h.calls.some((call) => call.path === path)).toBe(false);
			await page.click(page.button(`${item} key`));
			expect(h.calls.find((call) => call.path === path)?.input).toEqual({
				organizationId: ORG,
				keyId: "key-1",
			});
			for (const unmount of unmounts.splice(0)) act(() => unmount());
			document.body.replaceChildren();
			h.calls.length = 0;
		}
	});

	it("keeps the confirm dialog open until the destructive request settles", async () => {
		let finish!: () => void;
		const settled = new Promise((resolve) => {
			finish = () => resolve({ ok: true });
		});
		h.destructiveResult = () => settled;
		const page = await mount();
		await openMenu(page, "Revoke");
		await page.click(page.button("Revoke key"));
		// Base UI's Dialog.Close would close on the click itself.
		expect(document.body.textContent).toContain("Revoke CI?");
		expect(page.button("Working…")?.disabled).toBe(true);
		await act(async () => {
			finish();
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.body.textContent).not.toContain("Revoke CI?");
	});

	it("keeps the confirm dialog open with the error when the request fails", async () => {
		h.destructiveResult = () => Promise.reject(new Error("Key is in use"));
		const page = await mount();
		await openMenu(page, "Delete");
		await page.click(page.button("Delete key"));
		expect(document.body.textContent).toContain("Delete CI?");
		expect(document.body.textContent).toContain("Key is in use");
		expect(page.button("Delete key")?.disabled).toBe(false);
	});

	it("rotates only after step-up, with the token as a direct-client argument", async () => {
		const page = await mount();
		await openMenu(page, "Rotate");
		expect(document.body.textContent).toContain("Rotate CI?");
		await page.click(page.button("Rotate key"));
		const rotated = h.calls.find(
			(call) => call.path === "organizations.rotateApiKey",
		)!;
		expect(rotated.client).toBe("direct:su-token");
		expect(rotated.input).toEqual({ organizationId: ORG, keyId: "key-1" });
		// Only the rotation target crosses the step-up round trip.
		expect(h.stepUpIntents).toContainEqual({ keyId: "key-1", name: "CI" });
	});

	it("binds both key challenges to the organization's Descope tenant", async () => {
		const page = await mount();
		await page.click(page.button("Create key"));
		const hooks = h.stepUpHooks.filter((hook) =>
			[CREATE_API_KEY_STEP_UP_INTENT, ROTATE_API_KEY_STEP_UP_INTENT].includes(
				hook.intentKey as string,
			),
		);
		expect(new Set(hooks.map((hook) => hook.intentKey))).toEqual(
			new Set([CREATE_API_KEY_STEP_UP_INTENT, ROTATE_API_KEY_STEP_UP_INTENT]),
		);
		for (const hook of hooks) expect(hook.tenantId).toBe("descope-tenant-1");
	});

	it("resumes a rotation that survived a redirect and shows a failed round trip", async () => {
		h.resume[ROTATE_API_KEY_STEP_UP_INTENT] = {
			intent: { keyId: "key-1", name: "CI" },
			failure: "Step-up was cancelled",
		};
		const page = await mount();
		const rotateHook = h.stepUpHooks.find(
			(hook) => hook.intentKey === ROTATE_API_KEY_STEP_UP_INTENT,
		)!;
		expect(rotateHook.autoResume).toBe(true);
		expect(page.host.textContent).toContain("Step-up was cancelled");
		await act(async () => {
			(rotateHook.onResume as (token: string) => void)("su-resumed");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			h.calls.find((call) => call.path === "organizations.rotateApiKey"),
		).toMatchObject({ client: "direct:su-resumed", input: { keyId: "key-1" } });
	});
});

describe("API key browser preparation", () => {
	it("opens a prefilled draft for human review and refuses a second while busy", async () => {
		await mount();
		const tools = h.webMcpFactories.at(-1)!() as Array<{
			name: string;
			execute: (args: unknown) => Promise<{ isError?: boolean }>;
		}>;
		const prepare = tools.find(
			(tool) => tool.name === "prepare_create_api_key",
		)!;
		const draft = {
			name: "Browser drafted",
			environment: "test",
			scopes: ["apps:read"],
		};
		let result: { isError?: boolean } | undefined;
		await act(async () => {
			result = await prepare.execute(draft);
		});
		expect(result?.isError).not.toBe(true);
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(
			dialog.querySelector<HTMLInputElement>('input[name="name"]')?.value,
		).toBe("Browser drafted");
		// Preparation never issues a credential.
		expect(
			h.calls.some((call) => call.path === "organizations.createApiKey"),
		).toBe(false);
		await act(async () => {
			result = await prepare.execute(draft);
		});
		expect(result?.isError).toBe(true);
	});
});
