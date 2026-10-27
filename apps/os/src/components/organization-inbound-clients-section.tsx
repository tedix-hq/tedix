/**
 * Admin › Organization › Outside apps.
 *
 * Edits the organization's inbound client policy (`mcpInboundClientPolicy`
 * through `organizations.update`) and lists the outside apps people connected
 * or tried to connect (`organizations.listInboundClientInventory`). The API
 * re-checks admin authority on both and judges every connection itself; this
 * view only prepares the stored list.
 */
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	isClientIdMetadataDocumentUrl,
	McpInboundClientPolicySchema,
	type InboundClientInventoryItem,
	type McpInboundClientPolicy,
} from "@tedix/api-contract/schemas/mcp-grant";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Collection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { SettingsRow, SettingsRows } from "@/components/settings-row";
import { osApi } from "@/lib/api";
import {
	organizationInboundClientsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";

type Entry = McpInboundClientPolicy["entries"][number];

/** Apps without a published identity are allowed for this long by default. */
const TEMPORARY_ALLOW_DAYS = 90;

const EMPTY_POLICY: McpInboundClientPolicy = { mode: "audit", entries: [] };

function formatDate(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

function daysFromNow(days: number) {
	return new Date(Date.now() + days * 86_400_000).toISOString();
}

function sameClient(
	entry: { mcpServerId: string; clientId: string },
	other: { mcpServerId: string; clientId: string },
) {
	return (
		entry.mcpServerId === other.mcpServerId && entry.clientId === other.clientId
	);
}

function isLive(entry: Entry) {
	return !entry.expiresAt || Date.parse(entry.expiresAt) > Date.now();
}

/** The status an inventory row would get under the policy being edited. */
function draftStatus(
	policy: McpInboundClientPolicy,
	item: InboundClientInventoryItem,
): "allowed" | "unlisted" | "blocked" {
	const listed = policy.entries.some(
		(entry) => sameClient(entry, item) && isLive(entry),
	);
	if (listed) return "allowed";
	return policy.mode === "enforce" ? "blocked" : "unlisted";
}

const STATUS_COPY = {
	allowed: { label: "On the list", variant: "success" },
	unlisted: { label: "Not on the list", variant: "secondary" },
	blocked: { label: "Blocked", variant: "destructive" },
} as const;

export function OrganizationInboundClientsSection({
	organizationId,
}: {
	organizationId: string;
}) {
	const inventory = useQuery(
		organizationInboundClientsQueryOptions(organizationId),
	);
	if (inventory.isPending)
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>Outside apps</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<Text role="label" tone="secondary">
						Loading outside apps…
					</Text>
				</SettingsSectionContent>
			</SettingsSection>
		);
	if (inventory.isError || !inventory.data)
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>Outside apps</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<Alert variant="destructive">
						<AlertDescription>
							{errorMessage(
								inventory.error,
								"The list of outside apps could not be read.",
							)}
						</AlertDescription>
					</Alert>
				</SettingsSectionContent>
			</SettingsSection>
		);
	return (
		<InboundClientsEditor
			key={organizationId}
			organizationId={organizationId}
			stored={inventory.data.policy}
			storedInvalid={inventory.data.policyInvalid}
			items={inventory.data.items}
		/>
	);
}

function InboundClientsEditor({
	organizationId,
	stored,
	storedInvalid,
	items,
}: {
	organizationId: string;
	stored: McpInboundClientPolicy | null;
	storedInvalid: boolean;
	items: InboundClientInventoryItem[];
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const [policy, setPolicy] = useState<McpInboundClientPolicy>(() =>
		structuredClone(stored ?? EMPTY_POLICY),
	);
	const [draft, setDraft] = useState({
		clientId: "",
		mcpServerId: items[0]?.mcpServerId ?? "",
		expiresOn: "",
		note: "",
	});
	const [dirty, setDirty] = useState(false);
	const save = useMutation({
		mutationFn: (next: McpInboundClientPolicy) =>
			osApi.organizations.update({
				organizationId,
				metadata: { mcpInboundClientPolicy: next },
			}),
		onSuccess: async () => {
			setDirty(false);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.organizationInboundClients(),
				}),
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.organizationDetail(),
				}),
			]);
		},
	});
	const validation = McpInboundClientPolicySchema.safeParse(policy);
	const servers = [
		...new Map(
			[
				...items.map((item) => [item.mcpServerId, item.serverSlug] as const),
				...policy.entries.map(
					(entry) =>
						[
							entry.mcpServerId,
							items.find((item) => item.mcpServerId === entry.mcpServerId)
								?.serverSlug ?? null,
						] as const,
				),
			].reverse(),
		),
	];
	const serverLabel = (mcpServerId: string) =>
		servers.find(([idValue]) => idValue === mcpServerId)?.[1] ?? mcpServerId;
	const nameFor = (entry: { mcpServerId: string; clientId: string }) =>
		items.find((item) => sameClient(item, entry))?.clientName ?? null;
	const wouldBlock = items.filter(
		(item) =>
			item.connectedPeople > 0 &&
			!policy.entries.some((entry) => sameClient(entry, item) && isLive(entry)),
	);

	function edit(next: McpInboundClientPolicy) {
		setPolicy(next);
		setDirty(true);
		save.reset();
	}
	function allow(item: { mcpServerId: string; clientId: string }, note = "") {
		const temporary = !isClientIdMetadataDocumentUrl(item.clientId);
		edit({
			...policy,
			entries: [
				...policy.entries.filter((entry) => !sameClient(entry, item)),
				{
					mcpServerId: item.mcpServerId,
					clientId: item.clientId,
					...(temporary
						? { expiresAt: daysFromNow(TEMPORARY_ALLOW_DAYS) }
						: {}),
					...(note ? { note } : {}),
				},
			],
		});
	}
	const draftClientId = draft.clientId.trim();
	const draftNeedsExpiry =
		draftClientId !== "" && !isClientIdMetadataDocumentUrl(draftClientId);
	const draftExpiry = draft.expiresOn
		? new Date(`${draft.expiresOn}T23:59:59Z`)
		: null;
	const draftReady =
		draftClientId !== "" &&
		draft.mcpServerId !== "" &&
		(!draftNeedsExpiry ||
			(draftExpiry !== null && draftExpiry.getTime() > Date.now()));

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Outside apps</SectionTitle>
					<SectionDescription>
						Choose which outside apps people may use to reach this organization,
						such as an AI assistant or a coding agent. Start by watching which
						apps people use, then allow only the ones on your list.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="space-y-6">
				{storedInvalid && (
					<Alert variant="destructive">
						<AlertDescription>
							The saved list could not be read, so no outside app can connect
							right now. Save the list below to fix it.
						</AlertDescription>
					</Alert>
				)}

				<SettingsRows>
					<SettingsRow
						title="Only allow apps on the list"
						description={
							policy.mode === "enforce"
								? "Apps that are not on the list cannot connect, and people already using them lose access on their next request."
								: "Every app people sign in with can connect. Apps not on the list are recorded below so you can review them first."
						}
					>
						<Switch
							aria-label="Only allow apps on the list"
							checked={policy.mode === "enforce"}
							disabled={save.isPending}
							onCheckedChange={(checked) =>
								edit({ ...policy, mode: checked ? "enforce" : "audit" })
							}
						/>
					</SettingsRow>
				</SettingsRows>

				{policy.mode === "enforce" && wouldBlock.length > 0 && (
					<Alert variant="warning">
						<AlertDescription>
							{wouldBlock.length === 1
								? "1 app people use now is not on the list and will be blocked: "
								: `${wouldBlock.length} apps people use now are not on the list and will be blocked: `}
							{wouldBlock
								.map((item) => item.clientName ?? item.clientId)
								.join(", ")}
							.
						</AlertDescription>
					</Alert>
				)}

				<div className="space-y-2">
					<Text as="h3" role="body" weight="medium">
						Allowed apps
					</Text>
					{policy.entries.length === 0 ? (
						<Text role="label" tone="secondary">
							No apps on the list yet. Allow one from the apps seen below or add
							it by its ID.
						</Text>
					) : (
						<SettingsRows>
							<Collection appearance="inline" aria-label="Allowed apps">
								{policy.entries.map((entry) => (
									<li key={`${entry.mcpServerId} ${entry.clientId}`}>
										<SettingsRow
											title={nameFor(entry) ?? entry.clientId}
											description={
												<>
													<span className="block font-mono [overflow-wrap:anywhere]">
														{entry.clientId}
													</span>
													<span className="block">
														Through {serverLabel(entry.mcpServerId)}
														{entry.expiresAt
															? isLive(entry)
																? ` · allowed until ${formatDate(entry.expiresAt)}`
																: ` · expired ${formatDate(entry.expiresAt)}`
															: ""}
														{entry.note ? ` · ${entry.note}` : ""}
													</span>
												</>
											}
										>
											<Button
												variant="secondary"
												disabled={save.isPending}
												aria-label={`Remove ${nameFor(entry) ?? entry.clientId}`}
												onClick={() =>
													edit({
														...policy,
														entries: policy.entries.filter(
															(other) => !sameClient(other, entry),
														),
													})
												}
											>
												Remove
											</Button>
										</SettingsRow>
									</li>
								))}
							</Collection>
						</SettingsRows>
					)}
				</div>

				<div className="space-y-3">
					<Text as="h3" role="body" weight="medium">
						Add an app by its ID
					</Text>
					<Text role="label" tone="secondary">
						Apps that publish their identity at a web address can stay on the
						list. Other apps register themselves on the fly, so they can only be
						allowed until a date you choose.
					</Text>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1 sm:col-span-2">
							<Label htmlFor={`${id}-client`}>App ID or address</Label>
							<Input
								id={`${id}-client`}
								aria-label="App ID or address"
								value={draft.clientId}
								placeholder="https://app.example/oauth/client.json"
								disabled={save.isPending}
								onChange={(event) =>
									setDraft({ ...draft, clientId: event.target.value })
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-server`}>Connects through</Label>
							{servers.length > 0 ? (
								<Select
									value={draft.mcpServerId}
									disabled={save.isPending}
									onValueChange={(value) => {
										if (value)
											setDraft({ ...draft, mcpServerId: String(value) });
									}}
								>
									<SelectTrigger
										id={`${id}-server`}
										aria-label="Connects through"
									>
										<SelectValue>
											{servers.find(
												([value]) => value === draft.mcpServerId,
											)?.[1] ?? draft.mcpServerId}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{servers.map(([value, slug]) => (
											<SelectItem key={value} value={value}>
												{slug ?? value}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									id={`${id}-server`}
									aria-label="Connects through"
									value={draft.mcpServerId}
									placeholder="Server ID"
									disabled={save.isPending}
									onChange={(event) =>
										setDraft({ ...draft, mcpServerId: event.target.value })
									}
								/>
							)}
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-expires`}>
								{draftNeedsExpiry ? "Allow until" : "Allow until (optional)"}
							</Label>
							<Input
								id={`${id}-expires`}
								aria-label="Allow until"
								type="date"
								value={draft.expiresOn}
								disabled={save.isPending}
								onChange={(event) =>
									setDraft({ ...draft, expiresOn: event.target.value })
								}
							/>
						</div>
						<div className="space-y-1 sm:col-span-2">
							<Label htmlFor={`${id}-note`}>Why (optional)</Label>
							<Input
								id={`${id}-note`}
								aria-label="Why (optional)"
								value={draft.note}
								maxLength={500}
								disabled={save.isPending}
								onChange={(event) =>
									setDraft({ ...draft, note: event.target.value })
								}
							/>
						</div>
					</div>
					<Button
						variant="secondary"
						disabled={save.isPending || !draftReady}
						onClick={() => {
							const entry: Entry = {
								mcpServerId: draft.mcpServerId.trim(),
								clientId: draftClientId,
								...(draftExpiry
									? { expiresAt: draftExpiry.toISOString() }
									: {}),
								...(draft.note.trim() ? { note: draft.note.trim() } : {}),
							};
							edit({
								...policy,
								entries: [
									...policy.entries.filter(
										(other) => !sameClient(other, entry),
									),
									entry,
								],
							});
							setDraft({ ...draft, clientId: "", expiresOn: "", note: "" });
						}}
					>
						Add to the list
					</Button>
				</div>

				{!validation.success && (
					<Alert variant="destructive">
						<AlertDescription>
							{validation.error.issues.map((issue) => issue.message).join(". ")}
						</AlertDescription>
					</Alert>
				)}
				{save.isError && (
					<Alert variant="destructive">
						<AlertDescription>
							{errorMessage(save.error, "The list could not be saved.")}
						</AlertDescription>
					</Alert>
				)}
				{save.isSuccess && <Text role="label">Outside app list saved.</Text>}
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={
							save.isPending ||
							!validation.success ||
							(!dirty && !storedInvalid)
						}
						onClick={() => {
							if (validation.success) save.mutate(validation.data);
						}}
					>
						Save outside app list
					</Button>
				</div>

				<div className="space-y-2">
					<Text as="h3" role="body" weight="medium">
						Apps seen recently
					</Text>
					{items.length === 0 ? (
						<Text role="label" tone="secondary">
							No outside app has connected to this organization yet.
						</Text>
					) : (
						<SettingsRows>
							<Collection appearance="inline" aria-label="Apps seen recently">
								{items.map((item) => {
									const status = draftStatus(policy, item);
									const copy = STATUS_COPY[status];
									const last = item.lastAttempt;
									const details = [
										`Through ${item.serverSlug ?? item.mcpServerId}`,
										item.connectedPeople === 1
											? "1 person connected"
											: `${item.connectedPeople} people connected`,
										last
											? `last ${last.stage === "consent" ? "asked to connect" : "used"} ${formatDate(last.at)}${last.allowed ? "" : " and was blocked"}`
											: item.lastGrantedAt
												? `connected ${formatDate(item.lastGrantedAt)}`
												: null,
										last && last.denied > 0
											? `${last.denied} blocked ${last.denied === 1 ? "attempt" : "attempts"}`
											: null,
									].filter(Boolean);
									return (
										<li key={`${item.mcpServerId} ${item.clientId}`}>
											<SettingsRow
												title={
													<span className="flex flex-wrap items-center gap-2">
														{item.clientName ?? "Unnamed app"}
														<Badge variant={copy.variant}>{copy.label}</Badge>
													</span>
												}
												description={
													<>
														<span className="block font-mono [overflow-wrap:anywhere]">
															{item.clientId}
														</span>
														<span className="block">{details.join(" · ")}</span>
													</>
												}
											>
												{status !== "allowed" && (
													<Button
														variant="secondary"
														disabled={save.isPending}
														aria-label={`Allow ${item.clientName ?? item.clientId}`}
														onClick={() => allow(item)}
													>
														{item.clientKind === "cimd"
															? "Allow"
															: `Allow for ${TEMPORARY_ALLOW_DAYS} days`}
													</Button>
												)}
											</SettingsRow>
										</li>
									);
								})}
							</Collection>
						</SettingsRows>
					)}
				</div>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
