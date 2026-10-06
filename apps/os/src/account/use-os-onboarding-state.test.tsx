import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const organizations = vi.hoisted(() => ({
	listOsMine: vi.fn(),
	getMyOrganization: vi.fn(),
	listAllMine: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ osApi: { organizations } }));

import {
	selectOsOnboardingOwner,
	useOsOnboardingState,
} from "./use-os-onboarding-state";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

function Probe() {
	const onboarding = useOsOnboardingState();
	return (
		<div
			data-ready={String(onboarding.isReady)}
			data-owner={onboarding.onboardingOwner?.organizationSlug ?? ""}
		>
			{onboarding.isLoading ? "loading" : "settled"}
		</div>
	);
}

function renderProbe() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<Probe />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	organizations.listOsMine.mockReset();
	organizations.getMyOrganization.mockReset();
	organizations.listAllMine.mockReset();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("useOsOnboardingState", () => {
	it("does not bootstrap an account that already has a provisioned OS", async () => {
		organizations.listOsMine.mockResolvedValue({
			data: [
				{
					organizationId: "org-1",
					organizationName: "Acme",
					organizationSlug: "acme",
					organizationLogoUrl: null,
				},
			],
			pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
		});

		const container = renderProbe();
		await flush();

		expect(container.firstElementChild?.getAttribute("data-ready")).toBe(
			"true",
		);
		expect(organizations.getMyOrganization).not.toHaveBeenCalled();
		expect(organizations.listAllMine).not.toHaveBeenCalled();
	});

	it("resolves a fresh personal owner before a focused CLI flow continues", async () => {
		organizations.listOsMine.mockResolvedValue({
			data: [],
			pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
		});
		organizations.getMyOrganization.mockResolvedValue({});
		organizations.listAllMine.mockResolvedValue({
			data: [
				{
					member: { role: "owner" },
					organizationId: "org-personal",
					organizationName: "Personal Workspace",
					organizationSlug: "personal-new-user",
					organizationType: "personal",
				},
			],
			pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
		});

		const container = renderProbe();
		await flush();

		expect(container.firstElementChild?.getAttribute("data-ready")).toBe(
			"false",
		);
		expect(container.firstElementChild?.getAttribute("data-owner")).toBe(
			"personal-new-user",
		);
		expect(organizations.getMyOrganization).toHaveBeenCalledOnce();
		expect(organizations.listAllMine).toHaveBeenCalledOnce();
	});
});

describe("selectOsOnboardingOwner", () => {
	it("prefers a personal owner and falls back to another owned organization", () => {
		const teamOwner = {
			member: { role: "owner" },
			organizationId: "team",
			organizationName: "Team",
			organizationSlug: "team",
			organizationType: "organization",
		};
		const personalOwner = {
			member: { role: "owner" },
			organizationId: "personal",
			organizationName: "Personal",
			organizationSlug: "personal",
			organizationType: "personal",
		};

		expect(
			selectOsOnboardingOwner([teamOwner, personalOwner])?.organizationId,
		).toBe("personal");
		expect(selectOsOnboardingOwner([teamOwner])?.organizationId).toBe("team");
	});
});
