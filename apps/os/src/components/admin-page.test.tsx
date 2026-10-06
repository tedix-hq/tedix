import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
	context: {
		isPending: true,
		isError: false,
		data: undefined as unknown,
		error: null as unknown,
	},
	connections: { isPending: true, isError: false, data: undefined as unknown },
	billing: { isPending: true, isError: false, data: undefined as unknown },
	enabled: [] as Array<{ key: string; enabled: boolean }>,
}));

vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => state.context,
}));
vi.mock("@/lib/os-query-options", () => ({
	connectionsOverviewQueryOptions: () => ({ queryKey: ["connections"] }),
	billingOverviewQueryOptions: () => ({ queryKey: ["billing"] }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: ({
		queryKey,
		enabled,
	}: {
		queryKey: string[];
		enabled: boolean;
	}) => {
		state.enabled.push({ key: queryKey[0]!, enabled });
		return queryKey[0] === "connections" ? state.connections : state.billing;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		className,
	}: {
		to: string;
		children?: React.ReactNode;
		className?: string;
	}) => (
		<a className={className} href={to}>
			{children}
		</a>
	),
}));

import { AdminPage } from "./admin-page";

function currentContext(permissions: string[] = ["apps:read", "billing:read"]) {
	return {
		organization: { name: "Example Organization" },
		authority: {
			role: "admin",
			authType: "user",
			permissions,
			machineScopes: [],
		},
	};
}

describe("AdminPage", () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		state.context = {
			isPending: true,
			isError: false,
			data: undefined,
			error: null,
		};
		state.connections = { isPending: true, isError: false, data: undefined };
		state.billing = { isPending: true, isError: false, data: undefined };
		state.enabled.length = 0;
		container = document.createElement("div");
		document.body.append(container);
	});

	afterEach(() => {
		container.remove();
	});

	it("presents actionable organization settings without platform operations", async () => {
		const root = createRoot(container);
		await act(async () => root.render(<AdminPage />));

		expect(container.textContent).toContain("Admin");
		expect(container.textContent).toContain(
			"Manage your organization, access, connected services, and billing.",
		);
		expect(container.textContent).toContain("At a glance");
		expect(container.textContent).toContain("Loading organization identity");
		expect(state.enabled).toEqual([
			{ key: "connections", enabled: false },
			{ key: "billing", enabled: false },
		]);
		for (const destination of [
			"Organization",
			"Connections",
			"API keys",
			"Billing",
			"Payments",
		]) {
			expect(container.textContent).toContain(destination);
		}
		const frames = container.querySelectorAll(
			'[data-slot="icon-frame"][data-appearance="fill"][data-size="sm"]',
		);
		expect(frames).toHaveLength(5);

		for (const internalDetail of [
			"D1 authoritative",
			"Tenant origin",
			"AI routing",
			"MCP 2026 readiness",
			"MCP scan operations",
		]) {
			expect(container.textContent).not.toContain(internalDetail);
		}

		await act(async () => root.unmount());
	});

	it("reports missing credentials and paused AI capacity from live reads", async () => {
		state.context = {
			isPending: false,
			isError: false,
			data: currentContext(),
			error: null,
		};
		state.connections = {
			isPending: false,
			isError: false,
			data: {
				rows: [{ accountState: "missing" }, { accountState: "present" }],
				hasMore: true,
				verificationComplete: false,
				referencesComplete: false,
			},
		};
		state.billing = {
			isPending: false,
			isError: false,
			data: { plan: { name: "Pro" }, inferenceCapacity: { available: false } },
		};
		const root = createRoot(container);
		await act(async () => root.render(<AdminPage />));
		expect(container.textContent).toContain("Example Organization · admin");
		expect(container.textContent).toContain(
			"1 missing or expired among 2 loaded accounts; inventory is partial.",
		);
		expect(container.textContent).toContain(
			"AI inference capacity unavailable",
		);
		expect(container.textContent).not.toContain("Provider healthy");
		expect(state.enabled).toEqual([
			{ key: "connections", enabled: true },
			{ key: "billing", enabled: true },
		]);
		await act(async () => root.unmount());
	});

	it("distinguishes restricted access from available status", async () => {
		state.context = {
			isPending: false,
			isError: false,
			data: currentContext([]),
			error: null,
		};
		const root = createRoot(container);
		await act(async () => root.render(<AdminPage />));
		expect(container.textContent).toContain(
			"Your credential cannot read organization connections.",
		);
		expect(container.textContent).toContain(
			"Your credential cannot read billing status.",
		);
		expect(container.textContent).not.toContain("capacity available");
		await act(async () => root.unmount());
	});

	it("shows failed reads as unavailable and keeps settings reachable", async () => {
		state.context = {
			isPending: false,
			isError: false,
			data: currentContext(),
			error: null,
		};
		state.connections = { isPending: false, isError: true, data: undefined };
		state.billing = { isPending: false, isError: true, data: undefined };
		const root = createRoot(container);
		await act(async () => root.render(<AdminPage />));
		expect(container.textContent).toContain(
			"Credential inventory could not be read.",
		);
		expect(container.textContent).toContain(
			"Plan and capacity could not be read.",
		);
		expect(
			container.querySelector('a[href="/admin/connections"]'),
		).not.toBeNull();
		expect(container.querySelector('a[href="/admin/billing"]')).not.toBeNull();
		await act(async () => root.unmount());
	});
});
