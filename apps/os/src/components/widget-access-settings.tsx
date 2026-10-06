import { WidgetTediSelection } from "@/components/widget-tedi-selection";
import { WidgetAudiencePicker } from "@/components/widget-audience-picker";
import { evaluateEmbeddedWidgetAccess } from "@tedix/api-contract/schemas/embedded-widget-access";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import {
	EmbeddedWidgetAccessConfigurationSchema,
	type EmbeddedWidgetAccessPolicy,
} from "@tedix/api-contract/schemas/embedded-widget-access";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Switch } from "@/components/kumo/switch";
import { Textarea } from "@/components/kumo/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";

type Configuration = z.infer<typeof EmbeddedWidgetAccessConfigurationSchema>;
const reasons: Record<string, string> = {
	allowed: "This user can use the assistant.",
	installation_paused: "This installation is paused.",
	access_disabled: "Assistant access is off for this business.",
	user_required: "A signed-in user is required.",
	user_excluded: "This user is explicitly excluded.",
	user_not_selected: "This user is not in the selected audience.",
};
export function WidgetAccessSettings({
	initialBusinessId,
}: {
	initialBusinessId?: string;
}) {
	const [businessId, setBusinessId] = useState(initialBusinessId);
	const [search, setSearch] = useState("");
	const [offset, setOffset] = useState(0);
	const companies = useQuery(
		osQuery.tedis.listWidgetContacts.queryOptions({
			input: {
				kind: "companies",
				installationId: businessId,
				search: search.trim() || undefined,
				offset,
				limit: 50,
			},
		}),
	);
	const query = useQuery(
		osQuery.tedis.listWidgetAccessConfigurations.queryOptions({ input: {} }),
	);
	if (query.isPending || companies.isPending)
		return <p role="status">Loading access settings…</p>;
	if (query.isError || companies.isError)
		return (
			<Alert variant="destructive">
				<AlertTitle>Access settings unavailable</AlertTitle>
				<AlertDescription>
					{query.error?.message ?? companies.error?.message}
				</AlertDescription>
			</Alert>
		);
	if (!query.data.data.length)
		return (
			<Card>
				<CardHeader>
					<CardTitle>No installed businesses</CardTitle>
					<CardDescription>
						Connect a business installation before granting assistant access.
						Access settings cannot create or reuse another business’s
						installation.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	return (
		<section className="grid gap-4" aria-label="Widget access settings">
			<p className="text-sm text-kumo-subtle">
				Choose who can use the assistant in each installed business. Saving a
				restriction blocks new turns and widget operations, including existing
				sessions. A response already in progress may finish.
			</p>
			{businessId && (
				<Button
					variant="secondary"
					className="w-fit"
					onClick={() => {
						setBusinessId(undefined);
						setOffset(0);
					}}
				>
					Show all businesses
				</Button>
			)}
			<Input
				aria-label="Search audience businesses"
				placeholder="Search businesses…"
				value={search}
				onChange={(event) => {
					setSearch(event.target.value);
					setOffset(0);
				}}
			/>
			<p className="text-sm text-kumo-subtle">
				Search people identified by your application, including those who have
				not used the widget recently.
			</p>
			{companies.data.companies.map((company) => {
				const row = query.data.data.find(
					(config) => config.installationId === company.installationId,
				);
				return row ? (
					<InstallationAccess
						key={`${row.installationId}:${row.revision}`}
						row={row}
						companyName={company.name}
					/>
				) : null;
			})}
			{companies.data.companies.length === 0 && (
				<p role="status">No matching companies.</p>
			)}
			<nav className="flex gap-2" aria-label="Audience company pages">
				<Button
					variant="secondary"
					disabled={offset === 0}
					onClick={() => setOffset(Math.max(0, offset - 50))}
				>
					Previous companies
				</Button>
				<Button
					variant="secondary"
					disabled={companies.data.nextOffset === null}
					onClick={() => setOffset(companies.data.nextOffset ?? offset)}
				>
					Next companies
				</Button>
			</nav>
		</section>
	);
}
function InstallationAccess({
	row,
	companyName,
}: {
	row: Configuration;
	companyName: string | null;
}) {
	const contacts = useQuery(
		osQuery.tedis.listWidgetContacts.queryOptions({
			input: {
				kind: "people",
				installationId: row.installationId,
				offset: 0,
				limit: 50,
			},
		}),
	);
	const users = contacts.data?.people ?? [];
	const client = useQueryClient();
	const [draft, setDraft] = useState<EmbeddedWidgetAccessPolicy>(row.policy);
	const [allowedText, setAllowedText] = useState(
		row.policy.allowedUserIds.join("\n"),
	);
	const [deniedText, setDeniedText] = useState(
		row.policy.deniedUserIds.join("\n"),
	);
	const [user, setUser] = useState("");
	const parseIds = (text: string) => [
		...new Set(
			text
				.split(/[\n,]/)
				.map((id) => id.trim())
				.filter(Boolean),
		),
	];
	const save = useMutation({
		mutationFn: () =>
			osApi.tedis.updateWidgetAccessConfiguration({
				installationId: row.installationId,
				expectedRevision: row.revision,
				policy: {
					...draft,
					allowedUserIds: parseIds(allowedText),
					deniedUserIds: parseIds(deniedText),
				},
			}),
		onSuccess: async () => {
			await client.invalidateQueries({
				queryKey: osQuery.tedis.listWidgetAccessConfigurations.queryOptions({
					input: {},
				}).queryKey,
			});
		},
	});
	const preview = useMutation({
		mutationFn: () =>
			osApi.tedis.previewWidgetAccess({
				installationId: row.installationId,
				hostUserId: user.trim(),
			}),
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{companyName || row.businessName || `Company ${row.externalTenantId}`}
				</CardTitle>
				<CardDescription>{row.allowedOrigin}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				<WidgetTediSelection
					disabled={save.isPending}
					value={draft.tediSelection ?? row.tediSelection}
					tedis={row.availableTedis ?? []}
					onChange={(selection) =>
						setDraft({
							...draft,
							tediSelection: selection ?? row.tediSelection,
						})
					}
				/>
				<Badge
					variant={
						row.policy.enabled && row.status === "active"
							? "default"
							: "secondary"
					}
				>
					{row.policy.enabled && row.status === "active"
						? "Access on"
						: "Access off"}
				</Badge>
				{row.status === "paused" && (
					<p>
						This installation is paused by the platform. Enabling its audience
						will not resume the installation.
					</p>
				)}
				<label className="flex items-center gap-3">
					<Switch
						aria-label={`Assistant access for business ${row.externalTenantId}`}
						checked={draft.enabled}
						onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
					/>
					Allow embedded assistant
				</label>
				<label className="grid gap-2">
					Who can use it?
					<Select
						value={draft.users}
						onValueChange={(users) =>
							setDraft({ ...draft, users: users as "all" | "selected" })
						}
					>
						<SelectTrigger
							aria-label={`User audience for business ${row.externalTenantId}`}
						>
							<SelectValue>
								{draft.users === "all"
									? "All authenticated users"
									: "Selected users"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All authenticated users</SelectItem>
							<SelectItem value="selected">Selected users</SelectItem>
						</SelectContent>
					</Select>
				</label>
				{draft.users === "selected" && (
					<WidgetAudiencePicker
						label="Included people"
						installationId={row.installationId}
						selected={parseIds(allowedText)}
						onChange={(ids) => setAllowedText(ids.join("\n"))}
					/>
				)}
				<WidgetAudiencePicker
					label="Excluded people"
					installationId={row.installationId}
					selected={parseIds(deniedText)}
					onChange={(ids) => setDeniedText(ids.join("\n"))}
				/>
				<details>
					<summary className="cursor-pointer text-sm">
						Advanced: manage stable user IDs
					</summary>
					<p>
						For people not yet identified by your application. Excluded people
						cannot use the assistant, even if included above.
					</p>
					<label>
						Included IDs
						<Textarea
							aria-label="Advanced included user IDs"
							value={allowedText}
							onChange={(event) => setAllowedText(event.target.value)}
						/>
					</label>
					<label>
						Excluded IDs
						<Textarea
							aria-label="Advanced excluded user IDs"
							value={deniedText}
							onChange={(event) => setDeniedText(event.target.value)}
						/>
					</label>
				</details>
				<section aria-label="Draft audience preview" className="grid gap-2">
					<h3 className="font-medium">Preview before saving</h3>
					{contacts.isError && (
						<p role="alert">
							Contact preview unavailable. Saved selections are preserved.
						</p>
					)}
					<p>
						{
							users.filter(
								(user) =>
									evaluateEmbeddedWidgetAccess(
										{
											...row,
											policy: {
												...draft,
												allowedUserIds: parseIds(allowedText),
												deniedUserIds: parseIds(deniedText),
											},
										},
										user.hostUserId,
									).allowed,
							).length
						}{" "}
						of {users.length} people in this sample would have access.
					</p>
					<p className="text-sm text-kumo-subtle">
						Previewing up to 50 saved contacts. Search included or excluded
						people above to find other customers.
					</p>
					<details>
						<summary className="cursor-pointer">View matching people</summary>
						{users.map((user) => (
							<p key={user.hostUserId}>
								{user.name || user.email || `User ${user.hostUserId}`} ·{" "}
								{evaluateEmbeddedWidgetAccess(
									{
										...row,
										policy: {
											...draft,
											allowedUserIds: parseIds(allowedText),
											deniedUserIds: parseIds(deniedText),
										},
									},
									user.hostUserId,
								).allowed
									? "Allowed"
									: "Not allowed"}
							</p>
						))}
					</details>
				</section>

				<Button
					className="w-fit"
					disabled={save.isPending}
					onClick={() => save.mutate()}
				>
					{save.isPending ? "Saving…" : "Save access settings"}
				</Button>
				{save.isError && <p role="alert">{save.error.message}</p>}
				<p className="text-sm text-kumo-subtle">
					{row.revision
						? row.updatedAt
							? `Saved · ${new Date(row.updatedAt).toLocaleString()}`
							: "Saved"
						: "No audience restrictions saved"}
				</p>
				<label className="grid gap-2">
					Test a user against saved settings
					<Input
						aria-label={`Test user ID for business ${row.externalTenantId}`}
						value={user}
						onChange={(event) => {
							setUser(event.target.value);
							preview.reset();
						}}
						placeholder="User ID"
					/>
				</label>
				<Button
					className="w-fit"
					variant="secondary"
					disabled={!user.trim() || preview.isPending}
					onClick={() => preview.mutate()}
				>
					Test access
				</Button>
				{preview.data && (
					<p role="status">
						{preview.data.allowed ? "Allowed" : "Denied"}:{" "}
						{reasons[preview.data.reason]} Checked against saved settings.
					</p>
				)}
				{preview.isError && <p role="alert">{preview.error.message}</p>}
			</CardContent>
		</Card>
	);
}
