import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";
import type {
	CalendarAccountSelectionSchema,
	CalendarInfoSchema,
} from "@tedix/api-contract/schemas/calendar-coordinator";
import type { OsWorkspaceResourceSelection } from "@tedix/api-contract/schemas/os-workspaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";

type Account = z.infer<typeof CalendarAccountSelectionSchema> & {
	instanceLabel: string;
	accountSubject: string | null;
};
export type CalendarChoice = {
	account: Account;
	calendar: z.infer<typeof CalendarInfoSchema>;
};
export function calendarAccountInput(account: Account) {
	return {
		adapter: account.adapter,
		providerId: account.providerId,
		connectionScope: account.connectionScope,
		connectionInstanceId: account.connectionInstanceId,
	};
}
export function calendarAccountLabel(account: Account) {
	return `${account.adapter === "google" ? "Google" : "Outlook"} · ${account.instanceLabel}${account.accountSubject ? ` · ${account.accountSubject}` : " · Identity unavailable"}`;
}
export function calendarResourceSelection(
	choice: CalendarChoice,
): OsWorkspaceResourceSelection & { connectionInstanceId: string } {
	return {
		providerId: choice.account.providerId,
		connectionScope: choice.account.connectionScope,
		connectionInstanceId: choice.account.connectionInstanceId,
		resourceType: "calendar",
		providerResourceId: choice.calendar.id,
		name: choice.calendar.name,
		requiredScopes: [],
		metadata: {
			timeZone: choice.calendar.timeZone,
			calendarAdapter: choice.account.adapter,
		},
	};
}
export function CalendarResourcePicker({
	onSelect,
	providerId,
	tokenScope = "either",
	disabled = false,
}: {
	onSelect: (choice: CalendarChoice) => void;
	providerId?: string;
	tokenScope?: "user" | "tenant" | "either";
	disabled?: boolean;
}) {
	const [scope, setScope] = useState<"user" | "tenant">(
		tokenScope === "tenant" ? "tenant" : "user",
	);
	const [accountId, setAccountId] = useState("");
	const accounts = useQuery({
		...osQuery.calendarCoordinator.supportedAccounts.queryOptions({
			input: { scope },
		}),
		retry: false,
	});
	const available = (accounts.data ?? []).filter(
		(account) => !providerId || account.providerId === providerId,
	);
	const account = available.find(
		(row) => row.connectionInstanceId === accountId,
	);
	const calendars = useQuery({
		...osQuery.calendarCoordinator.listCalendars.queryOptions({
			input: account
				? calendarAccountInput(account)
				: {
						adapter: "google",
						providerId: "unselected",
						connectionScope: scope,
						connectionInstanceId: "00000000-0000-4000-8000-000000000000",
					},
		}),
		enabled: Boolean(account),
		retry: false,
	});
	return (
		<section className="grid gap-3" aria-label="Choose a connected calendar">
			{tokenScope === "either" && (
				<div className="flex gap-2">
					<Button
						type="button"
						variant={scope === "user" ? "default" : "outline"}
						onClick={() => {
							setScope("user");
							setAccountId("");
						}}
					>
						My accounts
					</Button>
					<Button
						type="button"
						variant={scope === "tenant" ? "default" : "outline"}
						onClick={() => {
							setScope("tenant");
							setAccountId("");
						}}
					>
						Organization accounts
					</Button>
				</div>
			)}
			<Text as="p" role="label">
				Connected account
			</Text>
			<Select
				items={available.map((row) => ({
					value: row.connectionInstanceId,
					label: calendarAccountLabel(row),
				}))}
				value={accountId}
				onValueChange={(value) => setAccountId(value ?? "")}
				disabled={disabled || accounts.isPending}
			>
				<SelectTrigger aria-label="Connected calendar account">
					<SelectValue placeholder="Choose an account" />
				</SelectTrigger>
				<SelectContent>
					{available.map((row) => (
						<SelectItem
							key={row.connectionInstanceId}
							value={row.connectionInstanceId}
						>
							{calendarAccountLabel(row)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{accounts.isPending && (
				<Text as="p" tone="secondary">
					Checking connected accounts…
				</Text>
			)}
			{accounts.isSuccess && available.length === 0 && (
				<Text as="p" tone="secondary">
					No supported accounts are available.{" "}
					<a
						href={
							scope === "user" ? "/account/connections" : "/admin/connections"
						}
					>
						Connect a calendar account
					</a>
					.
				</Text>
			)}
			{accounts.isError && (
				<Alert variant="warning">
					<AlertTitle>Calendar discovery unavailable</AlertTitle>
					<AlertDescription>
						Accounts could not be checked. No calendar has been selected.
					</AlertDescription>
				</Alert>
			)}
			{account && calendars.isPending && (
				<Text as="p" tone="secondary">
					Reading calendars from the selected account…
				</Text>
			)}
			{calendars.isError && (
				<Alert variant="warning">
					<AlertTitle>Could not read this account</AlertTitle>
					<AlertDescription>{calendars.error.message}</AlertDescription>
				</Alert>
			)}
			{calendars.data && (
				<>
					<Text as="p" tone="secondary">
						{calendarAccountLabel(calendars.data.account)}
					</Text>
					<ul className="m-0 grid list-none gap-2 p-0">
						{calendars.data.calendars.map((calendar) => (
							<li
								key={calendar.id}
								className="flex flex-wrap items-center justify-between gap-2"
							>
								<div>
									<Text as="p" role="body">
										{calendar.name}
									</Text>
									<Text as="p" tone="secondary" role="label">
										{calendar.canRead
											? calendar.canWrite
												? "Can read and add blockers"
												: "Read only"
											: "Cannot read"}
										{calendar.timeZone ? ` · ${calendar.timeZone}` : ""}
										{!calendar.conditionalWrites
											? " · Safe blocker updates unavailable"
											: ""}
									</Text>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={disabled || !calendar.canRead}
									onClick={() =>
										onSelect({ account: calendars.data.account, calendar })
									}
								>
									Choose calendar
								</Button>
							</li>
						))}
					</ul>
					{calendars.data.calendars.length === 0 && (
						<Text as="p" tone="secondary">
							This account returned no calendars.
						</Text>
					)}
				</>
			)}
		</section>
	);
}
