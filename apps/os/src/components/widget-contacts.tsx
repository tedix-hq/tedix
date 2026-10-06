import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
	EmbeddedContactUser,
	EmbeddedContactCompany,
} from "@tedix/api-contract/schemas/embedded-contact";
import { evaluateEmbeddedWidgetAccess } from "@tedix/api-contract/schemas/embedded-widget-access";
import { osQuery, appAnalyticsRange } from "@/lib/os-query-options";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
} from "@/components/kumo/dialog";
import {
	Table,
	TableHeader,
	TableBody,
	TableRow,
	TableHead,
	TableCell,
} from "@/components/kumo/table";

export function widgetPersonLabel(
	person: Pick<EmbeddedContactUser, "name" | "email" | "hostUserId">,
) {
	return person.name || person.email || `User ${person.hostUserId}`;
}
export function widgetBusinessLabel(
	company: Pick<EmbeddedContactCompany, "name" | "externalTenantId">,
) {
	return company.name || `Company ${company.externalTenantId}`;
}
function attributeLabel(key: string) {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.replace(/\bid\b/gi, "ID");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const time = (value: string | null | undefined) =>
	value ? new Date(value).toLocaleString() : "Not available";

export function WidgetContacts({
	onAudience,
}: {
	onAudience: (installationId: string) => void;
}) {
	const [kind, setKind] = useState<"people" | "companies">("people");
	const [search, setSearch] = useState("");
	const [offset, setOffset] = useState(0);
	const [business, setBusiness] = useState<EmbeddedContactCompany>();
	const [profile, setProfile] = useState<{
		installationId: string;
		hostUserId?: string;
	} | null>(null);
	const [range] = useState(appAnalyticsRange);
	const directory = useQuery(
		osQuery.tedis.listWidgetContacts.queryOptions({
			input: {
				kind,
				search: search.trim() || undefined,
				installationId: business?.installationId,
				offset,
				limit: 50,
			},
		}),
	);
	const access = useQuery(
		osQuery.tedis.listWidgetAccessConfigurations.queryOptions({ input: {} }),
	);
	const detail = useQuery({
		...osQuery.tedis.getWidgetContact.queryOptions({
			input: {
				installationId:
					profile?.installationId ?? "00000000-0000-4000-8000-000000000000",
				hostUserId: profile?.hostUserId,
			},
		}),
		enabled: profile !== null,
	});
	const history = useQuery({
		...osQuery.analytics.getEmbeddedProviderActivity.queryOptions({
			input: {
				...range,
				limit: 50,
				installationId: profile?.installationId,
				hostUserId: profile?.hostUserId,
			},
		}),
		enabled: profile !== null,
	});
	const company = detail.data?.company;
	const person = detail.data?.user;
	const policy = access.data?.data.find(
		(row) => row.installationId === profile?.installationId,
	);
	const decision =
		person && policy
			? evaluateEmbeddedWidgetAccess(policy, person.hostUserId)
			: undefined;
	const companies = directory.data?.companies ?? [];
	const people = directory.data?.people ?? [];
	const configs = new Map(
		(access.data?.data ?? []).map((row) => [row.installationId, row]),
	);
	const changeKind = (next: "people" | "companies") => {
		setKind(next);
		setOffset(0);
	};
	return (
		<section className="grid gap-4" aria-label="Widget customers">
			<Card>
				<CardHeader>
					<CardTitle>People & companies</CardTitle>
					<CardDescription>
						Find customer profiles and manage who can use your assistant.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4">
					<nav className="flex gap-2" aria-label="Customer directory">
						<Button
							variant={kind === "people" ? "default" : "secondary"}
							onClick={() => changeKind("people")}
						>
							People
						</Button>
						<Button
							variant={kind === "companies" ? "default" : "secondary"}
							onClick={() => changeKind("companies")}
						>
							Companies
						</Button>
					</nav>
					<Input
						aria-label="Search customers"
						placeholder={
							kind === "people"
								? "Search name, email or user ID…"
								: "Search company name or ID…"
						}
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setOffset(0);
						}}
					/>
					{business && (
						<div className="flex flex-wrap items-center gap-2">
							<p>
								Company: {widgetBusinessLabel(business)} · Company ID{" "}
								{business.externalTenantId}
							</p>
							<Button
								className="w-fit"
								variant="secondary"
								onClick={() => {
									setBusiness(undefined);
									setOffset(0);
								}}
							>
								Show all companies
							</Button>
						</div>
					)}
					{directory.isPending ? (
						<p role="status">Loading customers…</p>
					) : directory.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Customers unavailable</AlertTitle>
							<AlertDescription>Try refreshing the directory.</AlertDescription>
						</Alert>
					) : (
						<>
							{kind === "people" ? (
								<Table scrollLabel="Widget people">
									<TableHeader>
										<TableRow>
											<TableHead>Person</TableHead>
											<TableHead>Company</TableHead>
											<TableHead>Access</TableHead>
											<TableHead>Last seen</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{people.map((user) => {
											const employer = companies.find(
												(row) => row.installationId === user.installationId,
											);
											const config = configs.get(user.installationId);
											const allowed = config
												? evaluateEmbeddedWidgetAccess(config, user.hostUserId)
														.allowed
												: undefined;
											return (
												<TableRow
													key={`${user.installationId}:${user.hostUserId}`}
												>
													<TableCell>
														<Button
															variant="ghost"
															className="h-auto whitespace-normal text-left underline"
															onClick={() =>
																setProfile({
																	installationId: user.installationId,
																	hostUserId: user.hostUserId,
																})
															}
														>
															{widgetPersonLabel(user)}
														</Button>
														{user.email && (
															<p className="text-kumo-subtle">{user.email}</p>
														)}
														<p className="text-kumo-subtle">
															User ID {user.hostUserId}
														</p>
													</TableCell>
													<TableCell>
														<Button
															variant="ghost"
															onClick={() =>
																setProfile({
																	installationId: user.installationId,
																})
															}
														>
															{employer
																? widgetBusinessLabel(employer)
																: `Company ${user.externalTenantId}`}
														</Button>
													</TableCell>
													<TableCell>
														<Badge variant={allowed ? "success" : "secondary"}>
															{allowed === undefined
																? "Unavailable"
																: allowed
																	? "Allowed"
																	: "Not allowed"}
														</Badge>
													</TableCell>
													<TableCell>{time(user.lastSeenAt)}</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							) : (
								<Table scrollLabel="Widget companies">
									<TableHeader>
										<TableRow>
											<TableHead>Company</TableHead>
											<TableHead>Access</TableHead>
											<TableHead>Last seen</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{companies.map((row) => {
											const config = configs.get(row.installationId);
											return (
												<TableRow key={row.installationId}>
													<TableCell>
														<Button
															variant="ghost"
															className="underline"
															onClick={() =>
																setProfile({
																	installationId: row.installationId,
																})
															}
														>
															{widgetBusinessLabel(row)}
														</Button>
														<p className="text-kumo-subtle">
															Company ID {row.externalTenantId}
														</p>
													</TableCell>
													<TableCell>
														<Badge>
															{config
																? config.status === "active" &&
																	config.policy.enabled
																	? "On"
																	: "Off"
																: "Unavailable"}
														</Badge>
													</TableCell>
													<TableCell>{time(row.lastSeenAt)}</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							)}
							{(kind === "people" ? people.length : companies.length) === 0 && (
								<p role="status">No matching customers.</p>
							)}
							<nav
								className="flex items-center gap-3"
								aria-label="Customer pages"
							>
								<Button
									variant="secondary"
									disabled={offset === 0}
									onClick={() => setOffset(Math.max(0, offset - 50))}
								>
									Previous
								</Button>
								<p>
									{directory.data.total} {kind}
								</p>
								<Button
									variant="secondary"
									disabled={directory.data.nextOffset === null}
									onClick={() => setOffset(directory.data.nextOffset ?? offset)}
								>
									Next
								</Button>
							</nav>
						</>
					)}
				</CardContent>
			</Card>
			<Dialog
				open={profile !== null}
				onOpenChange={(open) => {
					if (!open) setProfile(null);
				}}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogTitle>
						{person
							? widgetPersonLabel(person)
							: company
								? widgetBusinessLabel(company)
								: "Customer profile"}
					</DialogTitle>
					<DialogDescription>
						{profile?.hostUserId
							? "Contact details supplied by your application."
							: "Company details supplied by your application."}
					</DialogDescription>
					{detail.isPending && <p role="status">Loading profile…</p>}
					{detail.isError && (
						<p role="alert">This profile could not be loaded.</p>
					)}
					{detail.data && company && (
						<>
							<section className="grid gap-2" aria-label="Profile details">
								{person && (
									<>
										<p>Name: {person.name || "Not supplied"}</p>
										<p>Email: {person.email || "Not supplied"}</p>
										<p>User ID: {person.hostUserId}</p>
										<p>
											Role:{" "}
											{person.role
												? attributeLabel(person.role)
												: "Not supplied"}
										</p>
									</>
								)}
								<p>Company: {widgetBusinessLabel(company)}</p>
								<p>Company ID: {company.externalTenantId}</p>
								<p>
									First seen: {time(person?.firstSeenAt ?? company.firstSeenAt)}
								</p>
								<p>
									Last seen: {time(person?.lastSeenAt ?? company.lastSeenAt)}
								</p>
								<p>
									Access:{" "}
									{decision
										? decision.allowed
											? "Allowed"
											: "Not allowed"
										: policy
											? policy.status === "active" && policy.policy.enabled
												? "On"
												: "Off"
											: "Unavailable"}
								</p>
								{Object.entries((person ?? company).customAttributes).map(
									([key, value]) => (
										<p key={key}>
											{attributeLabel(key)}:{" "}
											{typeof value === "boolean"
												? value
													? "Yes"
													: "No"
												: String(value)}
										</p>
									),
								)}
								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => {
											if (profile) onAudience(profile.installationId);
											setProfile(null);
										}}
									>
										Manage audience
									</Button>
									{!person && (
										<Button
											variant="secondary"
											onClick={() => {
												setBusiness(company);
												setKind("people");
												setSearch("");
												setOffset(0);
												setProfile(null);
											}}
										>
											View people
										</Button>
									)}
								</div>
							</section>
							<section
								className="grid gap-2"
								aria-label="Recent profile activity"
							>
								<h3 className="font-medium">Activity in the last 30 days</h3>
								{history.isPending && <p role="status">Loading activity…</p>}
								{history.isError && (
									<p>
										Activity is unavailable. Profile details are still
										available.
									</p>
								)}
								{history.data && history.data.recent.length === 0 && (
									<p>No recent activity.</p>
								)}
								{history.data?.recent.map((event) => (
									<p key={event.id}>
										{event.eventType === "embedded_session_started"
											? "Widget session started"
											: event.eventType.replaceAll("_", " ")}{" "}
										· {time(event.createdAt)}
									</p>
								))}
							</section>
						</>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}
