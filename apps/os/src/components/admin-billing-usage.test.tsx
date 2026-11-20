import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CreditUsage } from "@/lib/billing-credits";

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

import { BillingCreditCaps } from "./billing-credit-caps";
import { PayAsYouGoForm } from "./billing-pay-as-you-go";

function credits(): CreditUsage {
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
	};
}

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
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
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
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Edit cap for Nova"]',
				)!
				.click(),
		);
		const dialog = document.querySelector('[role="dialog"]')!;
		const input = dialog.querySelector<HTMLInputElement>(
			'input[placeholder="No cap"]',
		)!;
		await act(async () => typeInto(input, "99999"));
		expect(dialog.textContent).toContain("A cap can be at most");
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
