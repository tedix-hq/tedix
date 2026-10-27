import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";
import type {
	CalendarAccountSelectionSchema,
	CalendarInfoSchema,
} from "@tedix/api-contract/schemas/calendar-coordinator";
import type { OsWorkspaceResourceSelection } from "@tedix/api-contract/schemas/os-workspaces";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { SegmentedControl } from "@/components/kumo/segmented-control";
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
type PickerProps = {
	onSelect: (choice: CalendarChoice) => void;
	providerId?: string;
	tokenScope?: "user" | "tenant" | "either";
	disabled?: boolean;
};

export function CalendarResourcePicker(props: PickerProps) {
	return (
		<ScopedCalendarResourcePicker
			key={JSON.stringify([props.providerId, props.tokenScope ?? "either"])}
			{...props}
		/>
	);
}

function ScopedCalendarResourcePicker({
	onSelect,
	providerId,
	tokenScope = "either",
	disabled = false,
}: PickerProps) {
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
		(account) =>
			account.connectionScope === scope &&
			(!providerId || account.providerId === providerId),
	);
	const accountsReady =
		accounts.isSuccess && !accounts.isFetching && !accounts.isPlaceholderData;
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
		enabled: Boolean(account) && accountsReady,
		retry: false,
	});
	const response = calendars.data;
	const result =
		account &&
		response &&
		(
			[
				"adapter",
				"providerId",
				"connectionScope",
				"connectionInstanceId",
			] as const
		).every((key) => account[key] === response.account[key])
			? response
			: undefined;
	const calendarsReady =
		accountsReady &&
		calendars.isSuccess &&
		!calendars.isFetching &&
		!calendars.isPlaceholderData &&
		Boolean(result);
	return (
		<section
			className="grid min-w-0 gap-3 break-words [overflow-wrap:anywhere]"
			aria-label="Choose a connected calendar"
		>
			{tokenScope === "either" &&
				(disabled ? (
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant={scope === "user" ? "default" : "outline"}
							disabled
							aria-pressed={scope === "user"}
						>
							My accounts
						</Button>
						<Button
							type="button"
							variant={scope === "tenant" ? "default" : "outline"}
							disabled
							aria-pressed={scope === "tenant"}
						>
							Organization accounts
						</Button>
					</div>
				) : (
					<SegmentedControl
						ariaLabel="Whose accounts"
						value={scope}
						onValueChange={(next) => {
							setScope(next);
							setAccountId("");
						}}
						options={[
							{ value: "user", label: "My accounts" },
							{ value: "tenant", label: "Organization accounts" },
						]}
					/>
				))}
			<Text as="p" role="label">
				Connected account
			</Text>
			<Select
				items={available.map((row) => ({
					value: row.connectionInstanceId,
					label: calendarAccountLabel(row),
				}))}
				value={account?.connectionInstanceId ?? ""}
				onValueChange={(value) => {
					if (!disabled && accountsReady) setAccountId(value ?? "");
				}}
				disabled={disabled || !accountsReady}
			>
				<SelectTrigger
					className="w-full min-w-0"
					aria-label="Connected calendar account"
				>
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
			{(accounts.isPending || accounts.isFetching) && (
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
				<LoadError
					title={<>Calendar discovery unavailable</>}
					error={accounts.error}
					onRetry={() => {
						void accounts.refetch();
					}}
					retrying={accounts.isFetching}
					help="Cached details may be out of date. Try again before choosing a calendar."
					retryDisabled={disabled}
				/>
			)}
			{account && (calendars.isPending || calendars.isFetching) && (
				<Text as="p" tone="secondary">
					Reading calendars from the selected account…
				</Text>
			)}
			{account && calendars.isError && (
				<LoadError
					title={<>Could not read this account</>}
					error={calendars.error}
					onRetry={() => {
						void calendars.refetch();
					}}
					retrying={calendars.isFetching}
					help="Cached calendars may be out of date. Try again before choosing."
					retryDisabled={disabled || !accountsReady}
				/>
			)}
			{account && calendars.isSuccess && calendars.data && !result && (
				<Alert variant="warning">
					<AlertTitle>Calendar account changed</AlertTitle>
					<AlertDescription>
						These calendars do not match the selected account. Choose an account
						again.
					</AlertDescription>
				</Alert>
			)}
			{result && (
				<>
					<Text as="p" tone="secondary">
						{calendarAccountLabel(result.account)}
					</Text>
					<ul className="m-0 grid list-none gap-2 p-0">
						{result.calendars.map((calendar) => (
							<li
								key={calendar.id}
								className="flex flex-wrap items-center justify-between gap-2"
							>
								<div className="min-w-0 flex-1 basis-48">
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
									disabled={disabled || !calendarsReady || !calendar.canRead}
									onClick={() => {
										if (!disabled && calendarsReady && calendar.canRead)
											onSelect({ account: result.account, calendar });
									}}
								>
									Choose calendar
								</Button>
							</li>
						))}
					</ul>
					{result.calendars.length === 0 && (
						<Text as="p" tone="secondary">
							This account returned no calendars.
						</Text>
					)}
				</>
			)}
		</section>
	);
}
