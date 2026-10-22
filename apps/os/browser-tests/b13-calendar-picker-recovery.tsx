import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	CalendarResourcePicker,
	type CalendarChoice,
} from "../src/components/calendar-resource-picker";
import { osQuery } from "../src/lib/os-query-options";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
	},
});
type Props = {
	providerId?: string;
	tokenScope?: "user" | "tenant" | "either";
	disabled?: boolean;
};
declare global {
	interface Window {
		calendarFixture: {
			choices: CalendarChoice[];
			setProps: (props: Props) => void;
			refresh: (read: "accounts" | "calendars") => Promise<void>;
		};
	}
}
window.calendarFixture = {
	choices: [],
	setProps: () => {},
	refresh: async (read) => {
		await client.refetchQueries({
			queryKey:
				read === "accounts"
					? osQuery.calendarCoordinator.supportedAccounts.key()
					: osQuery.calendarCoordinator.listCalendars.key(),
			type: "active",
		});
	},
};
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
function Example() {
	const [props, setProps] = useState<Props>({});
	window.calendarFixture.setProps = setProps;
	return (
		<main className="mx-auto grid max-w-2xl gap-4 p-4 text-kumo-default">
			<h1 className="type-tedix-page-title">Choose a calendar</h1>
			<p className="text-kumo-subtle">
				Local fictional account discovery. Selection is recorded only in this
				fixture.
			</p>
			<CalendarResourcePicker
				{...props}
				onSelect={(choice) => {
					window.calendarFixture.choices.push(choice);
				}}
			/>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<Example />
	</QueryClientProvider>,
);
