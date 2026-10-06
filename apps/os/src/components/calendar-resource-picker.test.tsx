import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
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
});
