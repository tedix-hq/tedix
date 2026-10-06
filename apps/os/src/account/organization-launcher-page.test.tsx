import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const organizations = vi.hoisted(() => ({
	completeOsOnboarding: vi.fn(),
	create: vi.fn(),
	isSlugAvailable: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ osApi: { organizations } }));

import {
	isSlugConflictError,
	ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS,
	OrganizationLauncherContent,
	OrganizationOnboardingForm,
	OrganizationOnboardingFormView,
} from "./organization-launcher-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("OrganizationLauncherContent", () => {
	it("renders every provisioned surface per org, MCP as a copy entry", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="member@example.com"
				workspaces={[
					{
						organizationId: "1",
						name: "Acme",
						slug: "acme",
						provisioned: true,
						surfaces: [
							{
								surface: "os",
								href: "https://acme.os.tedix.dev/",
								copyValue: null,
							},
							{
								surface: "cms",
								href: "https://blog.acme.com/_emdash/admin",
								copyValue: null,
							},
							{
								surface: "mcp",
								href: null,
								copyValue: "https://acme.mcp.tedix.dev/mcp",
							},
						],
					},
				]}
			/>,
		);
		// Route-out surfaces render as anchors to their server-built canonical URL.
		expect(html).toContain('href="https://acme.os.tedix.dev/"');
		expect(html).toContain('href="https://blog.acme.com/_emdash/admin"');
		// MCP stays a copy/discovery action, never a route-out anchor. Technical
		// hostnames stay out of the scan path and are available from the control.
		expect(html).not.toContain('href="https://acme.mcp.tedix.dev/mcp"');
		expect(html).toContain('aria-label="Copy MCP gateway"');
		expect(html).toContain('aria-label="Open CMS"');
		expect(html).toContain('data-workspace-link="true"');
		expect(html).toContain("Search workspaces");
		expect(html).toContain("1 workspace");
		expect(html).not.toContain("Dashboard");
		expect(html).toContain("member@example.com");
		expect(html).not.toContain("TEDIX OS");
		expect(html).not.toContain(
			"Come back here anytime to switch between your workspaces.",
		);
	});

	// The launcher used to hand-roll its panel, list, rows, and links in
	// `styles.css` (`.org-launcher-card`, `.org-launcher-list`,
	// `.org-launcher-workspace-main`, …). Those ~270 lines were retired in
	// favour of the Kumo adapters, so the shell contract is asserted on the
	// adapter slots rather than on the deleted class names.
	it("composes its shell from Kumo adapters, not hand-written CSS", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="member@example.com"
				workspaces={[
					{
						organizationId: "1",
						name: "Acme",
						slug: "acme",
						provisioned: true,
						surfaces: [
							{
								surface: "os",
								href: "https://acme.os.tedix.dev/",
								copyValue: null,
							},
						],
					},
				]}
			/>,
		);
		// The bounded panel is a `Surface`, the collection is a divided `Card`.
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-slot="card"');
		expect(html).toContain("divide-y");
		// Nothing reaches for a retired account-surface class any more.
		for (const retired of [
			"org-launcher-card",
			"org-launcher-list",
			"org-launcher-workspace",
			"org-launcher-mark",
			"org-launcher-name",
			"org-launcher-lede",
			"org-launcher-identity",
			"org-launcher-foot",
			"org-launcher-filter",
			"org-launcher-account",
		]) {
			expect(html).not.toContain(retired);
		}
		// The full-viewport interstitial layout stays app-owned.
		expect(html).toContain('class="org-launcher"');
	});

	it("renders a non-provisionComplete org as disabled and never routed", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="member@example.com"
				workspaces={[
					{
						organizationId: "3",
						name: "Ghost Org",
						slug: "ghost",
						provisioned: false,
						surfaces: [],
					},
				]}
			/>,
		);
		expect(html).toContain("Ghost Org");
		expect(html).toContain("Provisioning");
		expect(html).toContain("still being set up");
		expect(html).toContain('aria-disabled="true"');
		// A disabled org fabricates no hostname and offers no route-out.
		expect(html).not.toContain("ghost.os.tedix.dev");
		expect(html).not.toContain("org-launcher-surface--route");
	});

	it("offers an account menu in production, but not in the local lane", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="member@example.com"
				workspaces={[]}
			/>,
		);
		expect(html).toContain('aria-haspopup="menu"');
		expect(html).toContain('href="/account/onboarding?new=1"');
		expect(html).toContain("New workspace");
		const local = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="operator@local.test"
				workspaces={[]}
				localEvaluation
			/>,
		);
		expect(local).not.toContain('aria-haspopup="menu"');
	});

	it("opens the production account menu without leaving the launcher", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<OrganizationLauncherContent
					email="member@example.com"
					workspaces={[]}
				/>,
			);
		});
		const trigger = container.querySelector<HTMLButtonElement>(
			'button[aria-haspopup="menu"]',
		);
		if (!trigger) throw new Error("account menu trigger not rendered");
		await act(async () => trigger.click());
		expect(document.body.textContent).toContain("Sign out");
		expect(document.body.textContent).toContain("Profile");
		expect(
			document.body.querySelector('a[href="/account/authorizations"]'),
		).not.toBeNull();
		expect(
			document.body.querySelector('a[href="/account/profile"]'),
		).not.toBeNull();
		act(() => root.unmount());
		container.remove();
	});

	it("explains zero provisioned memberships and denied return targets", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				workspaces={[]}
				email=""
				blockedReturnTarget
			/>,
		);
		expect(html).toContain("No workspace yet");
		expect(html).toContain("That workspace is not available");
	});

	it("opens an existing organization on its isolated localhost origin", () => {
		const html = renderToStaticMarkup(
			<OrganizationLauncherContent
				email="operator@local.test"
				localEvaluation
				workspaces={[
					{
						organizationId: "local-1",
						name: "My Local OS",
						slug: "my-local-os",
						provisioned: true,
						surfaces: [
							{
								surface: "os",
								href: "http://my-local-os.localhost:3030/",
								copyValue: null,
							},
						],
					},
				]}
			/>,
		);
		expect(html).toContain("Open your local OS");
		expect(html).toContain("http://my-local-os.localhost:3030/");
		expect(html).toContain("separate from production");
	});

	it("filters a long membership directory by workspace name or slug", () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		act(() => {
			root.render(
				<OrganizationLauncherContent
					email="member@example.com"
					workspaces={[
						{
							organizationId: "alpha",
							name: "Alpha Company",
							slug: "alpha",
							provisioned: true,
							surfaces: [],
						},
						{
							organizationId: "beta",
							name: "Beta Studio",
							slug: "beta",
							provisioned: true,
							surfaces: [
								{
									surface: "os",
									href: "https://beta.os.tedix.dev/",
									copyValue: null,
								},
							],
						},
					]}
				/>,
			);
		});

		const input = container.querySelector(
			'input[aria-label="Search workspaces"]',
		) as HTMLInputElement;
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "beta");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(container.textContent).toContain("Beta Studio");
		expect(container.textContent).not.toContain("Alpha Company");
		expect(container.textContent).toContain("1 workspace");
		act(() => root.unmount());
	});

	it("renders first-run workspace naming on the central auth origin", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="New User's Workspace"
				initialSlug="new-users-workspace"
				submitting={false}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Create your workspace");
		expect(html).toContain("new-user@tedix.tech");
		expect(html).toContain("https://new-users-workspace.os.tedix.dev");
		expect(html).toContain("Create workspace");
	});

	it("explains that CLI onboarding returns to the requesting terminal", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="New User's Workspace"
				initialSlug="new-users-workspace"
				completionTarget="cli"
				submitting={false}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Create workspace and continue");
		expect(html).toContain("returns you to the CLI");
	});

	it("frames localhost onboarding as starting an empty personal OS", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="operator@local.test"
				initialName="My Local OS"
				initialSlug="my-local-os"
				localEvaluation
				localPort="3030"
				submitting={false}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("START YOUR LOCAL TEDIX OS");
		expect(html).toContain("Name your OS");
		expect(html).toContain("Start my OS");
		expect(html).toContain("http://my-local-os.localhost:3030/");
		expect(html).toContain("Your workspace data stays on this machine");
		expect(html).toContain("prompts are sent to your configured provider");
	});

	it("points a slug conflict at the URL field and keeps the form enabled", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="Acme"
				initialSlug="acme"
				submitting={false}
				slugConflictMessage='Workspace URL "acme.os.tedix.dev" is already taken.'
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("is already taken");
		expect(html).toContain("Pick a different workspace URL");
		expect(html).toContain('role="alert"');
		expect(html).toContain('aria-invalid="true"');
		// The conflict is recoverable in place: no retry button, nothing disabled.
		expect(html).not.toContain("Try again");
		expect((html.match(/<input[^>]*\bdisabled=/g) ?? []).length).toBe(0);
	});

	it("offers an explicit safe retry for a provisioning failure", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="Acme"
				initialSlug="acme"
				submitting={false}
				provisioningError
				onRetry={() => undefined}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Something went wrong preparing your workspace.");
		expect(html).toContain("Retrying is safe");
		expect(html).toContain("reuses");
		expect(html).toContain("Try again");
	});

	it("disables both inputs and narrates provisioning while submitting", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="Acme"
				initialSlug="acme"
				submitting
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain(
			"Setting up your workspace… this can take a few seconds.",
		);
		expect(html).toContain('aria-live="polite"');
		expect((html.match(/<input[^>]*\bdisabled\b/g) ?? []).length).toBe(2);
	});

	it("renders the completion moment with a manual link instead of the form", () => {
		const html = renderToStaticMarkup(
			<OrganizationOnboardingFormView
				email="new-user@tedix.tech"
				initialName="Acme"
				initialSlug="acme"
				submitting={false}
				successUrl="https://acme.os.tedix.dev/"
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Your workspace is ready");
		expect(html).toContain('href="https://acme.os.tedix.dev/"');
		expect(html).toContain("acme.os.tedix.dev");
		expect(html).toContain("Opening your workspace…");
		expect(html).not.toContain("<form");
		// The manual path in is the shared `Link` adapter, not a bare anchor
		// styled by the retired `.org-onboarding-success-url` rule.
		expect(html).not.toContain("org-onboarding-success");
		expect(html).toContain('data-kumo-component="Link"');
	});
});

describe("isSlugConflictError", () => {
	it("matches only the typed oRPC CONFLICT error", () => {
		expect(
			isSlugConflictError(
				Object.assign(new Error("taken"), { code: "CONFLICT" }),
			),
		).toBe(true);
		expect(
			isSlugConflictError(
				Object.assign(new Error("retry"), { code: "SERVICE_UNAVAILABLE" }),
			),
		).toBe(false);
		expect(isSlugConflictError(new Error("plain"))).toBe(false);
		expect(isSlugConflictError(null)).toBe(false);
	});
});

describe("OrganizationOnboardingForm", () => {
	const cleanups: Array<() => void> = [];
	let assign: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		organizations.completeOsOnboarding.mockReset();
		organizations.create.mockReset();
		organizations.isSlugAvailable.mockReset();
		organizations.isSlugAvailable.mockResolvedValue({ available: true });
		assign = vi.fn();
		(window.location as unknown as { assign: unknown }).assign = assign;
	});

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
		vi.useRealTimers();
		delete (window.location as unknown as { assign?: unknown }).assign;
	});

	function renderForm(props?: {
		localEvaluation?: boolean;
		onComplete?: (organization: {
			id: string;
			name: string;
			slug: string;
		}) => void;
		organization?: { id: string; name: string; slug: string } | null;
	}) {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<OrganizationOnboardingForm
						email="owner@tedix.tech"
						organization={
							props?.organization === undefined
								? { id: "org-1", name: "Acme", slug: "acme" }
								: props.organization
						}
						localEvaluation={props?.localEvaluation ?? false}
						onComplete={props?.onComplete}
					/>
				</QueryClientProvider>,
			);
		});
		cleanups.push(() => {
			act(() => root.unmount());
			container.remove();
			queryClient.clear();
		});
		return container;
	}

	async function submit(container: HTMLElement) {
		const form = container.querySelector("form");
		if (!form) throw new Error("form not rendered");
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		// TanStack Query batches state notifications through a zero-ms timeout,
		// which fake timers hold; flush it without reaching the navigation delay.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	function typeInto(input: HTMLInputElement, value: string) {
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!setter) throw new Error("input value setter missing");
		act(() => {
			setter.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("creates the organization first when none exists, and reuses it on retry", async () => {
		organizations.create.mockResolvedValue({
			id: "org-new",
			name: "Beta",
			slug: "beta",
		});
		organizations.completeOsOnboarding
			.mockRejectedValueOnce(
				Object.assign(new Error("provisioning"), {
					code: "SERVICE_UNAVAILABLE",
				}),
			)
			.mockResolvedValueOnce({ id: "org-new", name: "Beta", slug: "beta" });
		const container = renderForm({ organization: null });
		const inputs = container.querySelectorAll("input");
		typeInto(inputs[0] as HTMLInputElement, "Beta");
		await submit(container);
		expect(organizations.create).toHaveBeenCalledWith({
			name: "Beta",
			slug: "beta",
		});
		expect(organizations.completeOsOnboarding).toHaveBeenCalledWith({
			organizationId: "org-new",
			name: "Beta",
			slug: "beta",
		});
		expect(container.textContent).toContain(
			"Something went wrong preparing your workspace.",
		);
		const retry = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Try again"),
		);
		if (!retry) throw new Error("retry button not rendered");
		await act(async () => {
			retry.click();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		// The retry completes onboarding against the SAME created organization.
		expect(organizations.create).toHaveBeenCalledTimes(1);
		expect(organizations.completeOsOnboarding).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Your workspace is ready");
	});

	it("shows the ready moment, then navigates after the delay", async () => {
		organizations.completeOsOnboarding.mockResolvedValue({
			id: "org-1",
			name: "Acme",
			slug: "acme",
		});
		const container = renderForm();
		await submit(container);
		expect(container.textContent).toContain("Your workspace is ready");
		expect(container.textContent).toContain("Opening your workspace…");
		// The manual anchor exists before any navigation happens.
		expect(
			container.querySelector(
				'a[href="https://acme.os.tedix.dev/workspaces?setup=1"]',
			),
		).not.toBeNull();
		expect(assign).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS);
		});
		expect(assign).toHaveBeenCalledWith(
			"https://acme.os.tedix.dev/workspaces?setup=1",
		);
	});

	it("opens workspaces after local first-run instead of the admission queue", async () => {
		organizations.completeOsOnboarding.mockResolvedValue({
			id: "org-1",
			name: "Acme",
			slug: "acme",
		});
		const container = renderForm({ localEvaluation: true });
		await submit(container);
		const target = `http://acme.localhost${window.location.port ? `:${window.location.port}` : ""}/workspaces?setup=1`;
		expect(container.querySelector(`a[href="${target}"]`)).not.toBeNull();
		act(() => {
			vi.advanceTimersByTime(ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS);
		});
		expect(assign).toHaveBeenCalledWith(target);
	});

	it("fires onComplete immediately with no success interstitial (CLI path)", async () => {
		organizations.completeOsOnboarding.mockResolvedValue({
			id: "org-1",
			name: "Acme",
			slug: "acme",
		});
		const onComplete = vi.fn();
		const container = renderForm({ onComplete });
		await submit(container);
		expect(onComplete).toHaveBeenCalledWith({
			id: "org-1",
			name: "Acme",
			slug: "acme",
		});
		expect(container.textContent).not.toContain("Your workspace is ready");
		act(() => {
			vi.advanceTimersByTime(ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS * 2);
		});
		expect(assign).not.toHaveBeenCalled();
	});

	it("renders a CONFLICT as an inline slug pointer with no retry button", async () => {
		organizations.completeOsOnboarding.mockRejectedValue(
			Object.assign(
				new Error('Workspace URL "acme.os.tedix.dev" is already taken'),
				{ code: "CONFLICT" },
			),
		);
		const container = renderForm();
		await submit(container);
		expect(container.textContent).toContain("is already taken");
		expect(container.textContent).toContain("Pick a different workspace URL");
		expect(container.textContent).not.toContain("Try again");
		// The form stays enabled for an in-place correction.
		const inputs = container.querySelectorAll("input");
		expect(inputs.length).toBe(2);
		for (const input of inputs) expect(input.disabled).toBe(false);
	});

	it("offers Try again for a provisioning failure and re-runs the mutation", async () => {
		organizations.completeOsOnboarding.mockRejectedValueOnce(
			Object.assign(
				new Error("Workspace gateway provisioning is incomplete."),
				{ code: "SERVICE_UNAVAILABLE" },
			),
		);
		organizations.completeOsOnboarding.mockResolvedValueOnce({
			id: "org-1",
			name: "Acme",
			slug: "acme",
		});
		const container = renderForm();
		await submit(container);
		expect(container.textContent).toContain(
			"Something went wrong preparing your workspace.",
		);
		expect(container.textContent).toContain("Retrying is safe");
		const retry = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Try again"),
		);
		if (!retry) throw new Error("Try again button not rendered");
		await act(async () => {
			retry.click();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(organizations.completeOsOnboarding).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Your workspace is ready");
	});

	it("never spends an availability check on the org's own seeded slug", async () => {
		// The field is seeded with the org's already-unique slug; checking it would
		// call this caller's own row "taken".
		renderForm();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(organizations.isSlugAvailable).not.toHaveBeenCalled();
	});

	it("flags a taken URL and disables submit after the debounced check", async () => {
		organizations.isSlugAvailable.mockResolvedValue({ available: false });
		const container = renderForm({ organization: null });
		const inputs = container.querySelectorAll("input");
		typeInto(inputs[0] as HTMLInputElement, "Beta");
		// Past the debounce so the check fires, then flush the query notification.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(organizations.isSlugAvailable).toHaveBeenCalled();
		expect(organizations.isSlugAvailable.mock.calls[0]?.[0]).toEqual({
			slug: "beta",
		});
		expect(container.textContent).toContain("That workspace URL is taken.");
		const submit = Array.from(container.querySelectorAll("button")).find(
			(button) => button.getAttribute("type") === "submit",
		);
		expect(submit?.disabled).toBe(true);
	});
});
