import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CreditPlan, CreditUsage } from "@/lib/billing-credits";

const billingCalls = vi.hoisted(() => ({
	setCreditCaps: vi.fn(),
	setPayAsYouGo: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get(target, property) {
				if (property === "billing")
					return new Proxy(target.billing, {
						get(billing, method) {
							return method in billingCalls
								? billingCalls[method as keyof typeof billingCalls]
								: Reflect.get(billing, method);
						},
					});
				return Reflect.get(target, property);
			},
		}),
	};
});

import {
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
	billingTopUpPacksQueryOptions,
} from "@/lib/os-query-options";
import { BillingUsageOverview } from "./admin-billing-usage";
import { BillingCreditCaps } from "./billing-credit-caps";
import { PayAsYouGoForm } from "./billing-pay-as-you-go";
import {
	planCardFeatures,
	SubscriptionSection,
} from "./billing-subscription-section";

const PLANS: CreditPlan[] = [
	{
		key: "starter",
		name: "Starter",
		priceMicros: 0,
		currency: "eur",
		includedCredits: 500,
	},
	{
		key: "growth",
		name: "Growth",
		priceMicros: 200_000_000,
		currency: "eur",
		includedCredits: 15_000,
	},
	{
		key: "business",
		name: "Business",
		priceMicros: 500_000_000,
		currency: "eur",
		includedCredits: 40_000,
	},
	{
		key: "enterprise",
		name: "Enterprise",
		priceMicros: 1_000_000_000,
		currency: "eur",
		includedCredits: 100_000,
	},
];

function credits(overrides: Partial<CreditUsage> = {}): CreditUsage {
	return {
		periodStart: "2026-11-01T00:00:00.000Z",
		periodEnd: "2026-12-01T00:00:00.000Z",
		includedCredits: 15_000,
		usedCredits: 12_600,
		remainingIncludedCredits: 2_400,
		topUpCredits: 5_000,
		breakdown: { ai: 10_900, codeRuns: 1_200, services: 500 },
		notices: [{ threshold: 80, reachedAt: "2026-11-19T00:00:00.000Z" }],
		payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		tedis: [
			{
				tediId: "tedi-fictional-a",
				name: "Nova",
				usedCredits: 6_200,
				monthlyCapCredits: 8_000,
			},
			{
				tediId: "tedi-fictional-b",
				name: "Miles",
				usedCredits: 4_900,
				monthlyCapCredits: null,
			},
		],
		members: [
			{
				userId: "user-fictional-a",
				name: "Sam Rivera",
				usedCredits: 1_500,
				monthlyCapCredits: 1_500,
			},
		],
		...overrides,
	};
}

function overview(usage: CreditUsage, planKey = "growth") {
	return {
		stripeEnvironment: "test" as const,
		snapshot: {
			status: "active" as const,
			planKey,
			periodStart: usage.periodStart,
			periodEnd: usage.periodEnd,
			stripeCustomerId: null,
		},
		plan: PLANS.find((plan) => plan.key === planKey)!,
		credits: usage,
	};
}

function seeded(usage: CreditUsage, planKey = "growth") {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
	client.setQueryData(
		billingOverviewQueryOptions().queryKey,
		overview(usage, planKey) as never,
	);
	client.setQueryData(billingPlansQueryOptions().queryKey, PLANS as never);
	client.setQueryData(billingTopUpPacksQueryOptions().queryKey, [
		{
			packKey: "credits-1000",
			credits: 1_000,
			priceMicros: 10_000_000,
			currency: "eur",
			validMonths: 12,
		},
		{
			packKey: "credits-5000",
			credits: 5_000,
			priceMicros: 50_000_000,
			currency: "eur",
			validMonths: 12,
		},
	] as never);
	return client;
}

function render(node: ReactNode, usage = credits(), planKey = "growth") {
	const client = seeded(usage, planKey);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
	client.clear();
	return html;
}

describe("billing usage in credits", () => {
	it("shows used, included, remaining and top-up credits with a breakdown", () => {
		const html = render(<BillingUsageOverview />);
		expect(html).toContain("Credits this month");
		expect(html).toContain("12,600 credits used");
		expect(html).toContain("84% of 15,000 credits included");
		expect(html).toContain("2,400 credits");
		expect(html).toContain("5,000 credits");
		expect(html).toContain('data-credit-breakdown="AI"');
		expect(html).toContain("10,900 credits");
		expect(html).toContain("Code runs");
		expect(html).toContain("1 credit per run");
		expect(html).toContain("Services");
	});

	it("raises the 80% notice with what is left", () => {
		const html = render(<BillingUsageOverview />);
		expect(html).toContain('data-credit-notice="80"');
		expect(html).toContain("80% of included credits are used");
	});

	it("raises the 100% notice and says work continues on top-ups", () => {
		const html = render(
			<BillingUsageOverview />,
			credits({
				usedCredits: 15_200,
				remainingIncludedCredits: 0,
				topUpCredits: 800,
				notices: [
					{ threshold: 80, reachedAt: "2026-11-10T00:00:00.000Z" },
					{ threshold: 100, reachedAt: "2026-11-18T00:00:00.000Z" },
				],
			}),
		);
		expect(html).toContain('data-credit-notice="100"');
		expect(html).toContain("All included credits are used");
	});

	it("says work has stopped when nothing is left and pay-as-you-go is off", () => {
		const html = render(
			<BillingUsageOverview />,
			credits({
				usedCredits: 15_000,
				remainingIncludedCredits: 0,
				topUpCredits: 0,
				notices: [{ threshold: 100, reachedAt: "2026-11-18T00:00:00.000Z" }],
			}),
		);
		expect(html).toContain('data-credit-notice="paused"');
		expect(html).toContain("out of credits");
		expect(html).toContain("turn on pay-as-you-go");
	});

	it("lists per-tedi and per-member usage with their monthly caps", () => {
		const html = render(<BillingUsageOverview />);
		expect(html).toContain("Usage by tedi and member");
		expect(html).toContain("6,200 credits of 8,000 credits used");
		expect(html).toContain("4,900 credits used · no separate cap");
		expect(html).toContain("cap of 1,500 credits reached");
	});

	it("offers credit packs through the existing checkout", () => {
		const html = render(<BillingUsageOverview />);
		expect(html).toContain("Buy credit packs");
		expect(html).toContain("1,000 credits");
		expect(html).toContain("Valid for 12 months");
		expect(html).toContain("Test purchase");
		expect(html).toContain("€10");
	});

	it("shows no tokens, daily limits or unlimited wording", () => {
		const html = render(<BillingUsageOverview />).toLowerCase();
		expect(html).not.toContain("token");
		expect(html).not.toContain("daily");
		expect(html).not.toContain("unlimited");
		expect(html).not.toContain("boost");
	});
});

describe("plan cards", () => {
	it("show each plan's monthly credits", () => {
		const html = render(<SubscriptionSection />, credits(), "starter");
		expect(html).toContain("Free");
		expect(html).toContain("500 credits a month");
		expect(html).toContain("15,000 credits a month (worth €150)");
		expect(html).toContain("40,000 credits a month");
		expect(html).toContain("From €1,000");
		expect(html.toLowerCase()).not.toContain("token");
		expect(html.toLowerCase()).not.toContain("unlimited");
	});

	it("describe Enterprise credits as a contract default", () => {
		expect(planCardFeatures(PLANS[3]!)).toEqual([
			"100,000 credits a month by default",
			"Monthly credits set in your contract",
			"Credit packs and pay-as-you-go available",
		]);
	});
});

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.replaceChildren();
	billingCalls.setCreditCaps.mockReset();
	billingCalls.setPayAsYouGo.mockReset();
});

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const client = seeded(credits());
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		),
	);
	return container;
}

function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("monthly caps", () => {
	it("saves a lower tedi cap and refuses one above the organization's credits", async () => {
		billingCalls.setCreditCaps.mockResolvedValue({ ok: true });
		const container = await mount(<BillingCreditCaps credits={credits()} />);
		const input = container.querySelector<HTMLInputElement>(
			'input[placeholder="No cap"]',
		)!;
		await act(async () => typeInto(input, "99999"));
		expect(container.textContent).toContain("A cap can be at most");
		await act(async () => typeInto(input, "5000"));
		const form = input.closest("form")!;
		await act(async () => {
			form.requestSubmit();
		});
		expect(billingCalls.setCreditCaps).toHaveBeenCalledWith({
			tediCaps: [{ tediId: "tedi-fictional-a", monthlyCapCredits: 5_000 }],
		});
	});
});

describe("pay-as-you-go", () => {
	it("requires a euro cap before it can be turned on", async () => {
		billingCalls.setPayAsYouGo.mockResolvedValue({ ok: true });
		const container = await mount(
			<PayAsYouGoForm
				settings={{ enabled: false, monthlyCapMicros: null, spentMicros: 0 }}
				onSaved={() => undefined}
			/>,
		);
		const toggle = container.querySelector<HTMLElement>(
			"#pay-as-you-go-enabled",
		)!;
		await act(async () => toggle.click());
		expect(container.textContent).toContain("Enter an amount above €0");
		const cap =
			container.querySelector<HTMLInputElement>("#pay-as-you-go-cap")!;
		await act(async () => typeInto(cap, "50"));
		expect(container.textContent).toContain(
			"Up to 5,000 extra credits a month",
		);
		const save = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Save",
		)!;
		await act(async () => save.click());
		expect(billingCalls.setPayAsYouGo).toHaveBeenCalledWith({
			enabled: true,
			monthlyCapMicros: 50_000_000,
		});
	});
});
