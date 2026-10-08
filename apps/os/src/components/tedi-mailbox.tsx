import { EnvelopeSimple, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EmailRoutingPolicy } from "@tedix/api-contract/schemas/tedi-email";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { toast } from "@/components/kumo/toast";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import {
	osQuery,
	osQueryKeys,
	tediDetailQueryOptions,
	tediEmailAddressesQueryOptions,
	tediEmailInboxQueryOptions,
	tediEmailThreadQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

type EmailAddress = Awaited<
	ReturnType<typeof osApi.tediEmail.listAddresses>
>["addresses"][number];
type InboxThread = Awaited<
	ReturnType<typeof osApi.tediEmail.listInbox>
>["threads"][number];
type ThreadMessage = Awaited<
	ReturnType<typeof osApi.tediEmail.readThread>
>["messages"][number];
type InboxFilter = NonNullable<
	Parameters<typeof tediEmailInboxQueryOptions>[1]
>;

export const TEDI_EMAIL_DOMAIN = "tedix.tech";
export const DEFAULT_SPAM_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The primary row first, then plus aliases, then anything platform-managed. */
const KIND_RANK: Record<EmailAddress["kind"], number> = {
	primary: 0,
	plus: 1,
	alias: 2,
	custom_domain: 3,
};

export function sortAddresses(addresses: readonly EmailAddress[]) {
	return [...addresses].sort(
		(a, b) =>
			KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
			a.address.localeCompare(b.address),
	);
}

/**
 * Form text → policy entries. Entries are split on newlines and commas,
 * trimmed and lowercased so the server's strict schema never rejects a
 * capitalised paste, and de-duplicated in first-seen order.
 */
export function parseSenderEntries(text: string): string[] {
	const seen = new Set<string>();
	for (const raw of text.split(/[\n,]/)) {
		const entry = raw.trim().toLowerCase();
		if (entry && !seen.has(entry)) seen.add(entry);
	}
	return [...seen];
}

const SENDER_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SENDER_DOMAIN = /^@[a-z0-9.-]+\.[a-z]{2,}$/;

export function invalidSenderEntries(entries: readonly string[]): string[] {
	return entries.filter(
		(entry) => !SENDER_EMAIL.test(entry) && !SENDER_DOMAIN.test(entry),
	);
}

/** Reads the stored JSON policy defensively; unknown shapes fall back to defaults. */
export function readRoutingPolicy(
	policy: EmailAddress["routingPolicy"],
): Required<Pick<EmailRoutingPolicy, "untrustedSenders" | "spamThreshold">> & {
	allowedSenders: string[];
	source: string | undefined;
} {
	const raw = (policy ?? {}) as Record<string, unknown>;
	const allowed = Array.isArray(raw.allowedSenders)
		? raw.allowedSenders.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	return {
		allowedSenders: allowed,
		source: typeof raw.source === "string" ? raw.source : undefined,
		untrustedSenders:
			raw.untrustedSenders === "quarantine" ? "quarantine" : "deliver",
		spamThreshold:
			typeof raw.spamThreshold === "number" &&
			Number.isFinite(raw.spamThreshold)
				? raw.spamThreshold
				: DEFAULT_SPAM_THRESHOLD,
	};
}

/** A plus tag is the `tag` in `{slug}+{tag}@tedix.tech`: lowercase, no spaces or `@`. */
export function normalizePlusTag(tag: string): string | null {
	const value = tag.trim().toLowerCase();
	return /^[a-z0-9._-]{1,64}$/.test(value) ? value : null;
}

export const ADDRESS_STATUS_VARIANTS: Record<
	EmailAddress["status"],
	BadgeVariant
> = { active: "success", paused: "warning", reserved: "outline" };

export const THREAD_STATUS_VARIANTS: Record<
	InboxThread["status"],
	BadgeVariant
> = { open: "default", archived: "secondary", spam: "destructive" };

const INBOX_FILTERS: readonly { value: InboxFilter; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "archived", label: "Archived" },
	{ value: "spam", label: "Spam" },
	{ value: "all", label: "All" },
];

function formatRecipient(
	recipient: { email: string; name?: string | null } | null | undefined,
): string {
	if (!recipient) return "Unknown sender";
	return recipient.name
		? `${recipient.name} <${recipient.email}>`
		: recipient.email;
}

// ---------------------------------------------------------------------------
// Address card
// ---------------------------------------------------------------------------

function AddressCard({
	tediId,
	slug,
	addresses,
}: {
	tediId: string;
	slug: string | null;
	addresses: EmailAddress[];
}) {
	const queryClient = useQueryClient();
	const [plusTag, setPlusTag] = useState("");
	const [showPlus, setShowPlus] = useState(false);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: osQueryKeys.tediEmail() });

	const create = useMutation({
		...osQuery.tediEmail.createAddress.mutationOptions(),
		onSuccess: async (result) => {
			await invalidate();
			setPlusTag("");
			setShowPlus(false);
			toast.success(`${result.address.address} is ready`);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not create the address")),
	});
	const update = useMutation({
		...osQuery.tediEmail.updateAddress.mutationOptions(),
		onSuccess: async (result) => {
			await invalidate();
			toast.success(
				result.address.status === "paused"
					? `${result.address.address} paused`
					: `${result.address.address} resumed`,
			);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not update the address")),
	});
	const remove = useMutation({
		...osQuery.tediEmail.deleteAddress.mutationOptions(),
		onSuccess: async (result) => {
			await invalidate();
			toast.success(`${result.address} retired`);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not retire the address")),
	});

	const primaryAddress = slug ? `${slug}@${TEDI_EMAIL_DOMAIN}` : null;
	const primary = addresses.find((row) => row.kind === "primary") ?? null;
	const busy = create.isPending || update.isPending || remove.isPending;

	if (addresses.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Mailbox</CardTitle>
					<CardDescription>
						Give this tedi its own email address. Mail sent to it lands in the
						inbox below and starts a turn.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<EnvelopeSimple aria-hidden />
							</EmptyMedia>
							<EmptyTitle>No mailbox yet</EmptyTitle>
							<EmptyDescription>
								{primaryAddress
									? `Enabling creates and activates ${primaryAddress}.`
									: "The tedi needs a slug before a mailbox can be enabled."}
							</EmptyDescription>
						</EmptyHeader>
						<Button
							variant="default"
							disabled={!primaryAddress || busy}
							onClick={() => {
								if (!primaryAddress) return;
								create.mutate({
									tediId,
									address: primaryAddress,
									kind: "primary",
								});
							}}
						>
							Enable mailbox
						</Button>
					</Empty>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Mailbox</CardTitle>
				<CardDescription>
					Addresses that route to this tedi. Pausing keeps the address but stops
					new mail from starting a turn.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<ul className="space-y-2" aria-label="Mailbox addresses">
					{sortAddresses(addresses).map((row) => (
						<li key={row.id}>
							<Surface className="flex flex-wrap items-center justify-between gap-2 p-3">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<Text role="body" tone="mono" className="break-all">
										{row.address}
									</Text>
									<Badge variant={ADDRESS_STATUS_VARIANTS[row.status]}>
										{row.status}
									</Badge>
									{row.kind !== "primary" && (
										<Badge variant="outline">
											{row.kind.replace("_", " ")}
										</Badge>
									)}
								</div>
								<div className="flex items-center gap-2">
									{row.status !== "reserved" && (
										<Button
											variant="secondary"
											size="sm"
											disabled={busy}
											onClick={() =>
												update.mutate({
													tediId,
													addressId: row.id,
													status: row.status === "paused" ? "active" : "paused",
												})
											}
										>
											{row.status === "paused" ? "Resume" : "Pause"}
										</Button>
									)}
									<AlertDialog>
										<AlertDialogTrigger
											render={
												<Button
													variant="ghost"
													size="sm"
													disabled={busy}
													aria-label={`Retire ${row.address}`}
												>
													<Trash aria-hidden />
													Retire
												</Button>
											}
										/>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Retire {row.address}?
												</AlertDialogTitle>
												<AlertDialogDescription>
													Mail sent to this address stops routing immediately.
													Stored threads and messages are kept.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>Cancel</AlertDialogCancel>
												<AlertDialogAction
													disabled={remove.isPending}
													onClick={() =>
														remove.mutate({ tediId, addressId: row.id })
													}
												>
													Retire address
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							</Surface>
						</li>
					))}
				</ul>

				{primary && slug && (
					<div className="space-y-2">
						{showPlus ? (
							<form
								className="flex flex-wrap items-end gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									const tag = normalizePlusTag(plusTag);
									if (!tag) {
										toast.error(
											"Use letters, numbers, dots, dashes or underscores for the tag",
										);
										return;
									}
									create.mutate({
										tediId,
										address: `${slug}+${tag}@${TEDI_EMAIL_DOMAIN}`,
										kind: "plus",
									});
								}}
							>
								<div className="space-y-1">
									<Label htmlFor="mailbox-plus-tag">Plus alias tag</Label>
									<div className="flex items-center gap-1">
										<Text role="body" tone="mono-secondary">
											{slug}+
										</Text>
										<Input
											id="mailbox-plus-tag"
											value={plusTag}
											placeholder="invoices"
											onChange={(event) => setPlusTag(event.target.value)}
										/>
										<Text role="body" tone="mono-secondary">
											@{TEDI_EMAIL_DOMAIN}
										</Text>
									</div>
								</div>
								<Button type="submit" variant="secondary" disabled={busy}>
									Add alias
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => setShowPlus(false)}
								>
									Cancel
								</Button>
							</form>
						) : (
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setShowPlus(true)}
							>
								<Plus aria-hidden />
								Add plus alias
							</Button>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Sender policy card
// ---------------------------------------------------------------------------

export function SenderPolicyCard({
	tediId,
	address,
}: {
	tediId: string;
	address: EmailAddress;
}) {
	const queryClient = useQueryClient();
	const stored = readRoutingPolicy(address.routingPolicy);
	const [senders, setSenders] = useState(stored.allowedSenders.join("\n"));
	const [untrusted, setUntrusted] = useState<"deliver" | "quarantine">(
		stored.untrustedSenders,
	);
	const [threshold, setThreshold] = useState(String(stored.spamThreshold));

	// Re-seed the form from the server copy whenever the row's policy changes
	// (another admin saved, or our own save returned a normalized copy).
	const policyKey = JSON.stringify(address.routingPolicy ?? null);
	useEffect(() => {
		const next = readRoutingPolicy(address.routingPolicy);
		setSenders(next.allowedSenders.join("\n"));
		setUntrusted(next.untrustedSenders);
		setThreshold(String(next.spamThreshold));
	}, [policyKey]);

	const save = useMutation({
		...osQuery.tediEmail.updateAddress.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediEmail(),
			});
			toast.success("Sender policy saved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not save the sender policy")),
	});

	const entries = parseSenderEntries(senders);
	const invalid = invalidSenderEntries(entries);
	const thresholdValue = Number(threshold);
	const thresholdInvalid =
		threshold.trim() === "" ||
		!Number.isFinite(thresholdValue) ||
		thresholdValue < 0 ||
		thresholdValue > 20;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Sender policy</CardTitle>
				<CardDescription>
					Trusted senders get the tedi's full tool set; everyone else can only
					receive a short reply.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="space-y-4"
					aria-label="Sender policy"
					onSubmit={(event) => {
						event.preventDefault();
						if (invalid.length > 0 || thresholdInvalid) return;
						// Policy-only save: status is omitted so a concurrent pause/resume
						// is never clobbered, and the creating surface's `source` label is kept.
						const routingPolicy: EmailRoutingPolicy = {
							allowedSenders: entries,
							untrustedSenders: untrusted,
							spamThreshold: thresholdValue,
							...(stored.source ? { source: stored.source } : {}),
						};
						save.mutate({ tediId, addressId: address.id, routingPolicy });
					}}
				>
					<div className="space-y-1">
						<Label htmlFor="mailbox-trusted-senders">Trusted senders</Label>
						<Textarea
							id="mailbox-trusted-senders"
							className="min-h-24 font-mono"
							value={senders}
							placeholder={"ana@example.com\n@example.com"}
							onChange={(event) => setSenders(event.target.value)}
							aria-describedby="mailbox-trusted-senders-help"
							aria-invalid={invalid.length > 0 || undefined}
						/>
						<Text
							id="mailbox-trusted-senders-help"
							role="caption"
							tone="secondary"
						>
							One per line: an email address or an @domain suffix. A sender is
							trusted only when its mail passes DKIM and DMARC.
						</Text>
						{invalid.length > 0 && (
							<Text role="caption" tone="error">
								Not an email or @domain: {invalid.join(", ")}
							</Text>
						)}
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1">
							<Label htmlFor="mailbox-untrusted-senders">Unknown senders</Label>
							<Select
								value={untrusted}
								onValueChange={(value) =>
									setUntrusted(
										value === "quarantine" ? "quarantine" : "deliver",
									)
								}
							>
								<SelectTrigger
									id="mailbox-untrusted-senders"
									className="w-full"
									aria-label="Unknown senders"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="deliver">
										Deliver with reply-only tools
									</SelectItem>
									<SelectItem value="quarantine">Quarantine as spam</SelectItem>
								</SelectContent>
							</Select>
							<Text role="caption" tone="secondary">
								Deliver lets the tedi answer briefly; Quarantine files the mail
								as spam without a turn.
							</Text>
						</div>
						<div className="space-y-1">
							<Label htmlFor="mailbox-spam-threshold">Spam threshold</Label>
							<Input
								id="mailbox-spam-threshold"
								type="number"
								min={0}
								max={20}
								step={0.5}
								value={threshold}
								onChange={(event) => setThreshold(event.target.value)}
								aria-invalid={thresholdInvalid || undefined}
							/>
							<Text role="caption" tone="secondary">
								Mail scoring at or above this is spam. Default{" "}
								{DEFAULT_SPAM_THRESHOLD}; lower is stricter.
							</Text>
						</div>
					</div>

					<div className="flex justify-end">
						<Button
							type="submit"
							variant="default"
							disabled={
								save.isPending || invalid.length > 0 || thresholdInvalid
							}
						>
							Save policy
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Inbox card
// ---------------------------------------------------------------------------

function ThreadMessages({
	tediId,
	threadId,
}: {
	tediId: string;
	threadId: string;
}) {
	const thread = useQuery(tediEmailThreadQueryOptions(tediId, threadId));
	if (thread.isPending) return <ListSkeleton rows={2} rowClassName="h-16" />;
	if (thread.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Could not load this thread</AlertTitle>
				<AlertDescription>{errorMessage(thread.error)}</AlertDescription>
			</Alert>
		);
	}
	return (
		<ol className="space-y-2" aria-label="Thread messages">
			{thread.data.messages.map((message: ThreadMessage) => (
				<li key={message.id}>
					<Surface className="space-y-1 p-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Text role="label">
								{message.direction === "outbound" ? "To " : "From "}
								{message.direction === "outbound"
									? message.to.map(formatRecipient).join(", ")
									: formatRecipient(message.from)}
							</Text>
							<Text role="caption" tone="secondary">
								{(message.receivedAt ?? message.sentAt)
									? absoluteTime(
											(message.receivedAt ?? message.sentAt) as string,
										)
									: ""}
							</Text>
						</div>
						<Text role="body" className="whitespace-pre-wrap break-words">
							{message.textBody ?? message.bodyPreview ?? "(no text body)"}
						</Text>
					</Surface>
				</li>
			))}
		</ol>
	);
}

export function InboxCard({ tediId }: { tediId: string }) {
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState<InboxFilter>("open");
	const [openThreadId, setOpenThreadId] = useState<string | null>(null);
	const inbox = useQuery(tediEmailInboxQueryOptions(tediId, filter));

	const mark = useMutation({
		...osQuery.tediEmail.mark.mutationOptions(),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tediEmail() }),
		onError: (error) =>
			toast.error(errorMessage(error, "Could not update the thread")),
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>Inbox</CardTitle>
				<CardDescription>
					Mail this tedi has received. Open a thread to read its messages.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<SegmentedControl
					ariaLabel="Inbox filter"
					value={filter}
					onValueChange={(value) => {
						setFilter(value);
						setOpenThreadId(null);
					}}
					options={INBOX_FILTERS}
					compact
				/>

				{inbox.isPending && <ListSkeleton rows={3} rowClassName="h-14" />}
				{inbox.isError && (
					<Alert variant="destructive">
						<AlertTitle>The inbox is unavailable</AlertTitle>
						<AlertDescription>{errorMessage(inbox.error)}</AlertDescription>
					</Alert>
				)}
				{inbox.data && inbox.data.threads.length === 0 && (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<EnvelopeSimple aria-hidden />
							</EmptyMedia>
							<EmptyTitle>Nothing here</EmptyTitle>
							<EmptyDescription>
								No {filter === "all" ? "" : `${filter} `}threads yet.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
				{inbox.data && inbox.data.threads.length > 0 && (
					<ul className="space-y-2" aria-label="Inbox threads">
						{inbox.data.threads.map((thread) => {
							const expanded = openThreadId === thread.id;
							const sender = formatRecipient(
								thread.latestMessage?.direction === "inbound"
									? thread.latestMessage.from
									: (thread.participants?.[0] ?? thread.latestMessage?.from),
							);
							return (
								<li key={thread.id} data-thread-id={thread.id}>
									<Surface className="space-y-2 p-3">
										<button
											type="button"
											className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
											aria-expanded={expanded}
											onClick={() => {
												setOpenThreadId(expanded ? null : thread.id);
												if (!expanded && thread.unreadCount > 0) {
													mark.mutate({
														tediId,
														threadId: thread.id,
														read: true,
													});
												}
											}}
										>
											<div className="min-w-0 space-y-0.5">
												<div className="flex flex-wrap items-center gap-2">
													<Text
														role="body"
														weight={
															thread.unreadCount > 0 ? "semibold" : "normal"
														}
													>
														{thread.latestMessage?.subject ||
															thread.subjectNorm ||
															"(no subject)"}
													</Text>
													{thread.unreadCount > 0 && (
														<Badge variant="default">
															{thread.unreadCount} unread
														</Badge>
													)}
													<Badge
														variant={THREAD_STATUS_VARIANTS[thread.status]}
													>
														{thread.status}
													</Badge>
												</div>
												<Text role="caption" tone="secondary">
													{sender}
												</Text>
											</div>
											<Text
												role="caption"
												tone="secondary"
												title={absoluteTime(thread.lastMessageAt)}
											>
												{relativeTime(thread.lastMessageAt)}
											</Text>
										</button>
										<div className="flex flex-wrap gap-2">
											{thread.unreadCount > 0 && (
												<Button
													variant="ghost"
													size="sm"
													disabled={mark.isPending}
													onClick={() =>
														mark.mutate({
															tediId,
															threadId: thread.id,
															read: true,
														})
													}
												>
													Mark read
												</Button>
											)}
											<Button
												variant="ghost"
												size="sm"
												disabled={mark.isPending}
												onClick={() =>
													mark.mutate({
														tediId,
														threadId: thread.id,
														archived: thread.status !== "archived",
													})
												}
											>
												{thread.status === "archived" ? "Unarchive" : "Archive"}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												disabled={mark.isPending}
												onClick={() =>
													mark.mutate({
														tediId,
														threadId: thread.id,
														spam: thread.status !== "spam",
													})
												}
											>
												{thread.status === "spam" ? "Not spam" : "Mark spam"}
											</Button>
										</div>
										{expanded && (
											<ThreadMessages tediId={tediId} threadId={thread.id} />
										)}
									</Surface>
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function TediMailbox({ tediId }: { tediId: string }) {
	const tedi = useQuery(tediDetailQueryOptions(tediId));
	const addresses = useQuery(tediEmailAddressesQueryOptions(tediId));

	if (addresses.isPending) {
		return <ListSkeleton rows={2} rowClassName="h-24" />;
	}
	if (addresses.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>The mailbox is unavailable</AlertTitle>
				<AlertDescription>{errorMessage(addresses.error)}</AlertDescription>
			</Alert>
		);
	}

	const rows = addresses.data.addresses;
	const policyAddress =
		rows.find((row) => row.kind === "primary") ?? rows[0] ?? null;

	return (
		<div className="space-y-4" data-testid="tedi-mailbox">
			<AddressCard
				tediId={tediId}
				slug={tedi.data?.slug ?? null}
				addresses={rows}
			/>
			{policyAddress && (
				<SenderPolicyCard tediId={tediId} address={policyAddress} />
			)}
			{rows.length > 0 && <InboxCard tediId={tediId} />}
		</div>
	);
}
