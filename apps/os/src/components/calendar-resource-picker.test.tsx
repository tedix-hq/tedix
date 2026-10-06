import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ listCalendars: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		calendarCoordinator: {
			supportedAccounts: vi.fn(),
			listCalendars: mocks.listCalendars,
		},
	},
}));
import { osQuery } from "@/lib/os-query-options";
import {
	CalendarResourcePicker,
	calendarAccountLabel,
	calendarResourceSelection,
} from "./calendar-resource-picker";
const account = {
	adapter: "google" as const,
	providerId: "calendar-provider",
	connectionScope: "user" as const,
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	instanceLabel: "Agency account",
	accountSubject: "person@example.test",
};
const calendar = {
	id: "opaque-calendar",
	name: "Agency meetings",
	timeZone: "Europe/Berlin",
	canRead: true,
	canWrite: true,
	ownerEmail: "person@example.test",
	conditionalWrites: true,
};
describe("calendar resource picker", () => {
	it("preserves exact named account identity and calendar ID in a canonical resource selection", () => {
		expect(calendarResourceSelection({ account, calendar })).toMatchObject({
			connectionInstanceId: account.connectionInstanceId,
			providerResourceId: calendar.id,
			providerId: account.providerId,
			connectionScope: "user",
			name: "Agency meetings",
			resourceType: "calendar",
		});
		expect(
			calendarResourceSelection({ account, calendar }).metadata,
		).not.toHaveProperty("connectionInstanceId");
		expect(calendarAccountLabel(account)).toContain("Agency account");
		expect(calendarAccountLabel(account)).toContain("person@example.test");
		expect(
			calendarAccountLabel({ ...account, accountSubject: null }),
		).toContain("Identity unavailable");
	});
	it("offers real account selection without asking users to type IDs", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			osQuery.calendarCoordinator.supportedAccounts.queryOptions({
				input: { scope: "user" },
			}).queryKey,
			[account],
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<CalendarResourcePicker onSelect={() => {}} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Choose an account");
		expect(html).not.toContain("Provider resource ID");
		expect(html).not.toContain(account.connectionInstanceId);
	});
	it("keeps the readable account label after selecting an unverified named account", async () => {
		const unverified = { ...account, accountSubject: null };
		const message =
			"This calendar account needs identity verification before its calendars can be read. Open Connections to verify this account.";
		mocks.listCalendars.mockReset().mockRejectedValue(new Error(message));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		queryClient.setQueryData(
			osQuery.calendarCoordinator.supportedAccounts.queryOptions({
				input: { scope: "user" },
			}).queryKey,
			[unverified],
		);
		const node = document.createElement("div");
		document.body.appendChild(node);
		const root = createRoot(node);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={queryClient}>
						<CalendarResourcePicker onSelect={() => {}} />
					</QueryClientProvider>,
				),
			);
			const trigger = node.querySelector<HTMLButtonElement>(
				'[aria-label="Connected calendar account"]',
			)!;
			await act(async () => trigger.click());
			const option = Array.from(
				document.querySelectorAll<HTMLElement>('[role="option"]'),
			).find((row) => row.textContent?.includes("Agency account"))!;
			expect(option).toBeTruthy();
			await act(async () => {
				option.click();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(trigger.textContent).toContain(
				"Google · Agency account · Identity unavailable",
			);
			expect(trigger.textContent).not.toContain(account.connectionInstanceId);
			expect(mocks.listCalendars).toHaveBeenCalledWith(
				{
					adapter: "google",
					providerId: account.providerId,
					connectionScope: "user",
					connectionInstanceId: account.connectionInstanceId,
				},
				expect.anything(),
			);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			expect(node.textContent).toContain(message);
			expect(node.textContent).not.toContain(account.connectionInstanceId);
		} finally {
			await act(async () => root.unmount());
			queryClient.clear();
			node.remove();
		}
	});
});
