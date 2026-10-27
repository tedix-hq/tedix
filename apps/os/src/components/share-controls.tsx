import {
	Buildings,
	CaretRight,
	Check,
	Copy,
	ArrowsClockwise,
	DotsThree,
	Globe,
	LinkSimple,
	Lock,
	PencilSimple,
	Prohibit,
	ShareNetwork,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type OsShareAccess,
	OsShareAccessSchema,
	type OsShareGuestRefusal,
	type OsShareLink,
	type OsShareResourceType,
	type OsShareRevisionMode,
	type OsShareRole,
} from "@tedix/api-contract/contracts/os-shares";
import { resolveOsTenant } from "@/shared/os-tenant";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { DateTimePicker } from "@/components/kumo/date-picker";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osSharesQueryOptions,
	shareInviteesQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

declare const __LOCAL_DEMO_ENABLED__: boolean;

export type ShareLinkStatus = "active" | "off" | "expired" | "revoked";

export function shareStatus(
	share: Pick<OsShareLink, "expiresAt" | "revokedAt" | "disabledAt">,
	now: Date = new Date(),
): ShareLinkStatus {
	if (share.revokedAt !== null) return "revoked";
	// A link from before "off" existed has no disabledAt at all; it is active.
	if (share.disabledAt) return "off";
	if (
		share.expiresAt !== null &&
		Date.parse(share.expiresAt) <= now.getTime()
	) {
		return "expired";
	}
	return "active";
}

export function shareStatusVariant(
	status: ShareLinkStatus,
): "success" | "warning" | "secondary" {
	if (status === "active") return "success";
	if (status === "expired") return "warning";
	return "secondary";
}

export function shareExpiryLabel(
	share: Pick<OsShareLink, "expiresAt" | "revokedAt" | "disabledAt">,
): string {
	if (share.expiresAt === null) return "never expires";
	const verb = shareStatus(share) === "expired" ? "expired" : "expires";
	return `${verb} ${relativeTime(share.expiresAt)}`;
}

/** Server messages are written for people; bare status words are not. */
function shareErrorText(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message.trim() : "";
	// "Not Found", "Forbidden", "fetch failed": a status, not an explanation.
	return message.split(/\s+/).length >= 4
		? message
		: `${fallback} Try again later.`;
}

const RESOURCE_NOUN: Record<OsShareResourceType, string> = {
	output: "file",
	gadget: "app",
	workspace: "workspace",
};

const ROLE_LABEL: Record<OsShareRole, string> = {
	viewer: "Can view",
	use: "Can use",
	build: "Can build",
};

const ROLE_VERB: Record<OsShareRole, string> = {
	viewer: "view",
	use: "use",
	build: "build",
};

const STATUS_LABEL: Record<ShareLinkStatus, string> = {
	active: "Active",
	off: "Off",
	expired: "Expired",
	revoked: "Deleted",
};

function revisionModeLabel(mode: OsShareRevisionMode): string {
	return mode === "pinned" ? "This version" : "Latest version";
}

/** One form field: label, control, optional hint, always the same spacing. */
function ShareField(props: {
	label: string;
	hint?: string;
	as?: "label" | "div";
	children: ReactNode;
}) {
	const Wrapper = props.as ?? "label";
	return (
		<Wrapper className="grid gap-1.5" data-slot="share-field">
			<Text as="span" role="label" tone="strong" className="m-0">
				{props.label}
			</Text>
			{props.children}
			{props.hint ? (
				<Text as="span" role="label" tone="secondary" className="m-0">
					{props.hint}
				</Text>
			) : null}
		</Wrapper>
	);
}

/** What a share row asks before a link stops working. */
export type ShareRevokeConfirmation = { activeSessionCount: number };

/**
 * One link: what it allows, in one line, and a quiet menu for the rest
 * (Edit settings, Get a new link, Turn off), each offered only when passed.
 */
export function ShareRow(props: {
	share: OsShareLink;
	onRevoke?: (shareId: string) => void;
	/** Change note, expiry or role in place; owners and admins only. */
	onEditSettings?: (share: OsShareLink) => void;
	onEdit?: (share: OsShareLink) => void;
	revoking?: boolean;
	confirmRevoke?: ShareRevokeConfirmation | null;
	onConfirmRevoke?: (shareId: string) => void;
	onCancelRevoke?: () => void;
	/** This link is open in the edit form below the list. */
	editing?: boolean;
}) {
	useOsFormattingPreferences();
	const status = shareStatus(props.share);
	const active = status === "active";
	const confirm = props.confirmRevoke;
	const hasMenu =
		active && (props.onEditSettings || props.onEdit || props.onRevoke);
	return (
		<li className="grid gap-2 py-2" data-share-row>
			<div className="flex min-h-9 items-center gap-2">
				<LinkSimple size={14} className="shrink-0 text-kumo-subtle" />
				<div className="grid min-w-0 flex-1 gap-0.5">
					<Text
						as="span"
						role="body"
						tone={active ? "strong" : "secondary"}
						className="m-0 truncate"
					>
						{props.share.note || "Link"}
						{props.editing ? " · editing below" : ""}
					</Text>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="m-0 truncate"
						title={`Created ${absoluteTime(props.share.createdAt)}`}
					>
						{ROLE_LABEL[props.share.role]} ·{" "}
						{revisionModeLabel(props.share.revisionMode).toLowerCase()} ·{" "}
						{shareExpiryLabel(props.share)} · created{" "}
						{relativeTime(props.share.createdAt)}
					</Text>
				</div>
				{active ? null : (
					<Badge variant={shareStatusVariant(status)}>
						{STATUS_LABEL[status]}
					</Badge>
				)}
				{hasMenu ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Options for ${props.share.note || "link"}`}
									disabled={props.revoking}
								/>
							}
						>
							<DotsThree size={16} weight="bold" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{props.onEditSettings ? (
								<DropdownMenuItem
									onClick={() => props.onEditSettings?.(props.share)}
								>
									<PencilSimple size={14} /> Edit settings
								</DropdownMenuItem>
							) : null}
							{props.onEdit ? (
								<DropdownMenuItem onClick={() => props.onEdit?.(props.share)}>
									<ArrowsClockwise size={14} /> Get a new link
								</DropdownMenuItem>
							) : null}
							{props.onRevoke ? (
								<DropdownMenuItem
									variant="destructive"
									onClick={() => props.onRevoke?.(props.share.id)}
								>
									<Prohibit size={14} /> Turn off
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
			{props.share.policyMaxRole && (
				<Text as="span" role="label" tone="warning" className="m-0 pl-6">
					Your organization limits this link to{" "}
					{ROLE_LABEL[props.share.policyMaxRole].toLowerCase()}:{" "}
					{props.share.policyReason}
				</Text>
			)}
			{active && confirm && (
				<Alert variant="warning">
					<Prohibit aria-hidden />
					<AlertTitle>Turn off this link?</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>
							It stops working right away.{" "}
							{confirm.activeSessionCount === 0
								? "Nobody has it open now."
								: `${confirm.activeSessionCount} ${
										confirm.activeSessionCount === 1
											? "person has"
											: "people have"
									} it open now and will lose access.`}{" "}
							You can make a new link any time.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="destructive"
								disabled={props.revoking}
								onClick={() => props.onConfirmRevoke?.(props.share.id)}
							>
								Turn off link
							</Button>
							<Button size="sm" variant="ghost" onClick={props.onCancelRevoke}>
								Keep link
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			)}
		</li>
	);
}

/** A link's address, shown right where the link was made. */
export function FreshLink(props: {
	url: string;
	title?: string;
	note: string;
	onDismiss?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Surface className="grid gap-2 p-3" data-share-new-link>
			<Text as="span" role="label" tone="strong" className="m-0">
				{props.title ?? "Your link is ready"}
			</Text>
			<Text
				as="code"
				role="label"
				tone="strong"
				className="m-0 select-all break-all rounded-md bg-kumo-recessed px-2 py-1.5 font-mono"
				aria-label="Share link URL"
				data-share-url
			>
				{props.url}
			</Text>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					autoFocus
					onClick={() => {
						navigator.clipboard?.writeText(props.url).then(
							() => setCopied(true),
							() => setCopied(false),
						);
					}}
				>
					<Copy size={14} /> {copied ? "Copied" : "Copy link"}
				</Button>
				{props.onDismiss ? (
					<Button variant="ghost" size="sm" onClick={props.onDismiss}>
						Done
					</Button>
				) : null}
			</div>
			<Text role="label" tone="secondary" className="m-0">
				{props.note}
			</Text>
		</Surface>
	);
}

/** The settings one link carries; the same form makes and changes a link. */
type LinkSettings = {
	role: OsShareRole;
	revisionMode: OsShareRevisionMode;
	note: string;
	expiresAt: Date | null;
};

function LinkForm(props: {
	resourceType: OsShareResourceType;
	noun: string;
	initial: LinkSettings;
	cannotPinRevision: boolean;
	/** The link changed in place: same address, so the version it shows stays. */
	editing: OsShareLink | null;
	pending: boolean;
	onSubmit: (settings: LinkSettings) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState<LinkSettings>(props.initial);
	const set = (patch: Partial<LinkSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const cannotPin = props.cannotPinRevision;
	return (
		<Surface className="grid gap-4 p-3" data-share-form>
			<Text as="h3" role="label" tone="strong" className="m-0">
				{props.editing
					? `Settings for “${props.editing.note || "Link"}”`
					: "New link with options"}
			</Text>
			{props.resourceType !== "output" && (
				<ShareField as="div" label="People with the link can">
					<SegmentedControl
						ariaLabel="Share access role"
						fill
						value={settings.role as "use" | "build"}
						onValueChange={(role) => set({ role })}
						options={[
							{ value: "use", label: "Use" },
							{ value: "build", label: "Build" },
						]}
					/>
				</ShareField>
			)}
			{props.editing ? null : (
				<ShareField
					as="div"
					label="Link shows"
					hint={
						cannotPin
							? `Save this ${props.noun} first to share a fixed version.`
							: undefined
					}
				>
					<SegmentedControl
						ariaLabel="Share revision behavior"
						fill
						value={settings.revisionMode}
						onValueChange={(revisionMode) => set({ revisionMode })}
						options={
							cannotPin
								? [{ value: "living", label: "Latest version" }]
								: [
										{ value: "living", label: "Latest version" },
										{ value: "pinned", label: "This version" },
									]
						}
					/>
				</ShareField>
			)}
			<ShareField label="Note (optional)">
				<Input
					value={settings.note}
					onChange={(event) => set({ note: event.target.value })}
					aria-label="Share note"
					maxLength={240}
					placeholder="For example: for the team to review"
				/>
			</ShareField>
			{/* A composite control has no single labellable input, so this is a
			    described group rather than an implicit <label>. */}
			<ShareField as="div" label="Expires (optional)">
				<DateTimePicker
					aria-label="Link expiry"
					value={settings.expiresAt}
					onChange={(expiresAt) => set({ expiresAt })}
					min={new Date()}
					placeholder="Never"
				/>
			</ShareField>
			{props.editing ? (
				<Text role="label" tone="secondary" className="m-0">
					The link stays the same; people who have it see the new settings.
				</Text>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					className="flex-1 justify-center"
					loading={props.pending}
					disabled={
						props.pending || (settings.revisionMode === "pinned" && cannotPin)
					}
					onClick={() => props.onSubmit(settings)}
				>
					{props.editing ? (
						"Save"
					) : (
						<>
							<LinkSimple size={14} /> Create link
						</>
					)}
				</Button>
				{props.onCancel && (
					<Button variant="ghost" onClick={props.onCancel}>
						Cancel
					</Button>
				)}
			</div>
		</Surface>
	);
}

/** Review rounds live in the app's Review tab; Share only points there. */
function ReviewEntry(props: { onOpen: () => void }) {
	const context = useOsOperationalContext();
	// The API lets only the organization owner send a round.
	if (context.data?.authority.role !== "owner") return null;
	return (
		<div className="border-kumo-line border-t pt-2">
			<Button
				variant="ghost"
				size="sm"
				className="-mx-2 justify-start"
				onClick={props.onOpen}
				data-share-review-entry
			>
				Ask people to review items
				<CaretRight size={12} aria-hidden />
			</Button>
		</div>
	);
}

type ShareResource =
	| { outputId: string; currentRevisionId?: string | null }
	| {
			resourceType: "gadget" | "workspace";
			resourceId: string;
			currentRevisionId?: string | null;
	  };

type ShareLinksPanelProps = ShareResource & {
	/** Opens the app's Review tab, where review rounds are sent. */
	onOpenReview?: () => void;
};

type ShareControlsProps = ShareLinksPanelProps & {
	compact?: boolean;
	/** Text of the full-size trigger; "Share" by default. */
	label?: string;
};

function normalizeResource(props: ShareResource): {
	resourceType: OsShareResourceType;
	resourceId: string;
	currentRevisionId: string | null;
} {
	if ("outputId" in props) {
		return {
			resourceType: "output",
			resourceId: props.outputId,
			currentRevisionId: props.currentRevisionId ?? null,
		};
	}
	return {
		resourceType: props.resourceType,
		resourceId: props.resourceId,
		currentRevisionId: props.currentRevisionId ?? null,
	};
}

/** Why "Anyone with the link" will not open this app for people without a Tedix account. */
export function guestRefusalText(
	refusal: OsShareGuestRefusal,
	organization: string,
): string {
	if (refusal.reason === "not_runtime_app")
		return `People without a Tedix account can't open this app: it works through Tedix skills and connected accounts, so it needs a sign-in. Choose "People in ${organization}" to share it with your team.`;
	const slot = `"${refusal.slot ?? "a resource"}"`;
	const why =
		refusal.reason === "connection_grant"
			? `it can reach a connected account through ${slot}`
			: `${slot} is not a Tedix Output, or its Output holds data from connected accounts`;
	return `People without a Tedix account can't open this app through a link: ${why}, and Tedix can't check what they may see there. Invite them to the workspace instead, or remove that access from the app.`;
}

type FormMode =
	| { kind: "closed" }
	| { kind: "create" }
	| { kind: "settings"; share: OsShareLink };

/** Changing a live link in place is for organization owners and admins. */
function useCanEditLinkSettings(): boolean {
	const permissions: readonly string[] =
		useOsOperationalContext().data?.authority.permissions ?? [];
	return (
		permissions.includes("os:admin") || permissions.includes("settings:manage")
	);
}

function accessLabel(access: OsShareAccess, organization: string): string {
	if (access === "anyone_with_link") return "Anyone with the link";
	if (access === "organization") return `People in ${organization}`;
	return "Only people you invite";
}

/** The one line under the dialog: what the chosen audience means. */
function accessHint(access: OsShareAccess, organization: string): string {
	if (access === "anyone_with_link")
		return "Anyone who has the address can open it, without signing in.";
	if (access === "organization")
		return `People in ${organization} open it after signing in with their ${organization} account.`;
	return "Only the people you add can open it, after signing in with that email address.";
}

const ACCESS_ICON: Record<OsShareAccess, typeof Globe> = {
	anyone_with_link: Globe,
	organization: Buildings,
	invited: Lock,
};

/** The link's permanent address, always on show, with a copy button. */
export function PermanentUrl(props: { url: string; off?: boolean }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-2" data-share-permanent-url>
			<Text
				as="code"
				role="label"
				tone={props.off ? "secondary" : "strong"}
				className={`m-0 min-w-0 flex-1 select-all truncate rounded-md bg-kumo-recessed px-2 py-1.5 font-mono${props.off ? " line-through" : ""}`}
				aria-label="Link address"
				data-share-url
			>
				{props.url}
			</Text>
			<Button
				size="sm"
				className="shrink-0"
				disabled={props.off}
				onClick={() => {
					navigator.clipboard?.writeText(props.url).then(
						() => setCopied(true),
						() => setCopied(false),
					);
				}}
			>
				<Copy size={14} /> {copied ? "Copied" : "Copy link"}
			</Button>
		</div>
	);
}

/** Who may open an "Only people you invite" link. */
function InviteList(props: { shareId: string }) {
	const queryClient = useQueryClient();
	const inviteesQuery = shareInviteesQueryOptions(props.shareId);
	const invitees = useQuery(inviteesQuery);
	const [email, setEmail] = useState("");
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: inviteesQuery.queryKey });
	const add = useMutation({
		mutationFn: () =>
			osApi.osShares.shares.invitees.add({
				shareId: props.shareId,
				email: email.trim(),
			}),
		onSuccess: () => setEmail(""),
		onSettled: () => void refresh(),
	});
	const remove = useMutation({
		mutationFn: (inviteeId: string) =>
			osApi.osShares.shares.invitees.remove({
				shareId: props.shareId,
				inviteeId,
			}),
		onSettled: () => void refresh(),
	});
	const items = invitees.data?.items ?? [];
	return (
		<section
			className="grid gap-2"
			aria-label="Invited people"
			data-share-invitees
		>
			<Text as="h3" role="label" tone="strong" className="m-0">
				Invited people
			</Text>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (email.trim()) add.mutate();
				}}
			>
				<Input
					aria-label="Email address to invite"
					type="email"
					autoComplete="off"
					placeholder="name@company.com"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					className="min-w-0 flex-1"
				/>
				<Button
					type="submit"
					variant="secondary"
					loading={add.isPending}
					disabled={!email.trim() || add.isPending}
				>
					Add
				</Button>
			</form>
			{add.isError ? (
				<Text role="label" tone="error" className="m-0" aria-live="polite">
					{shareErrorText(add.error, "Couldn't add that person.")}
				</Text>
			) : null}
			{invitees.isSuccess && items.length === 0 ? (
				<Text role="label" tone="secondary" className="m-0">
					Nobody yet. Add the people who should open this link.
				</Text>
			) : null}
			{items.length > 0 ? (
				<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
					{items.map((invitee) => {
						const label = invitee.name ?? invitee.email ?? "Someone";
						return (
							<li
								key={invitee.id}
								className="flex min-h-10 items-center gap-2"
								data-share-invitee={invitee.id}
							>
								<Text
									as="span"
									role="body"
									className="m-0 min-w-0 flex-1 truncate"
								>
									{label}
								</Text>
								<Button
									variant="ghost"
									size="sm"
									aria-label={`Remove ${label}`}
									disabled={remove.isPending}
									onClick={() => remove.mutate(invitee.id)}
								>
									Remove
								</Button>
							</li>
						);
					})}
				</ul>
			) : null}
			{remove.isError ? (
				<Text role="label" tone="error" className="m-0" aria-live="polite">
					{shareErrorText(remove.error, "Couldn't remove that person.")}
				</Text>
			) : null}
		</section>
	);
}

/**
 * The link to one app or file: its permanent address with Copy, who may
 * open it, the invite list when only invited people may, and Turn off. It
 * has no surface of its own, so it sits inside the workspace Share dialog
 * or inside ShareControls' own dialog.
 */
export function ShareLinksPanel(props: ShareLinksPanelProps) {
	const { resourceType, resourceId, currentRevisionId } =
		normalizeResource(props);
	const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
	const [staged, setStaged] = useState<OsShareAccess | null>(null);
	const [confirmOff, setConfirmOff] = useState<{
		shareId: string;
		activeSessionCount: number;
	} | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const sharesQuery = osSharesQueryOptions({ resourceType, resourceId });
	const shares = useQuery(sharesQuery);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey });
	const organization =
		useOsOperationalContext().data?.organization?.name ?? "your organization";
	const canEditSettings = useCanEditLinkSettings();
	// A turned-off link keeps its address, so it stays the resource's link.
	const listedLinks = (shares.data?.items ?? []).filter((share) =>
		["active", "off"].includes(shareStatus(share)),
	);
	const link = listedLinks[0] ?? null;
	const linkOff = link !== null && shareStatus(link) === "off";
	const defaultRole: OsShareRole = resourceType === "output" ? "viewer" : "use";
	const noun = RESOURCE_NOUN[resourceType];
	const cannotPinRevision =
		resourceType !== "workspace" && currentRevisionId === null;

	const createLink = useMutation({
		mutationFn: (settings: LinkSettings) => {
			const pinnedRevisionId =
				settings.revisionMode === "pinned" && resourceType !== "workspace"
					? currentRevisionId
					: null;
			return osApi.osShares.shares.create({
				resourceType,
				resourceId,
				role: settings.role,
				access,
				revisionMode: settings.revisionMode,
				...(pinnedRevisionId ? { pinnedRevisionId } : {}),
				...(settings.note.trim() ? { note: settings.note.trim() } : {}),
				...(settings.expiresAt
					? { expiresAt: settings.expiresAt.toISOString() }
					: {}),
			});
		},
		onSuccess: () => {
			setStaged(null);
			setFormMode({ kind: "closed" });
		},
		onSettled: () => void invalidate(),
	});
	// Choosing who can open an existing link changes it at once; the address
	// stays the same.
	const changeAccess = useMutation({
		mutationFn: (input: { shareId: string; access: OsShareAccess }) =>
			osApi.osShares.shares.update(input),
		onSettled: () => void invalidate(),
	});
	// While a change is on its way, the choice already shows as made.
	const access: OsShareAccess =
		(link
			? ((changeAccess.isPending ? changeAccess.variables?.access : null) ??
				link.access)
			: staged) ?? "anyone_with_link";
	const updateSettings = useMutation({
		mutationFn: (input: { share: OsShareLink; settings: LinkSettings }) => {
			const { role, note, expiresAt } = input.settings;
			return osApi.osShares.shares.update({
				shareId: input.share.id,
				...(role !== input.share.role ? { role } : {}),
				note: note.trim() || null,
				expiresAt: expiresAt ? expiresAt.toISOString() : null,
			});
		},
		onSuccess: () => setFormMode({ kind: "closed" }),
		onSettled: () => void invalidate(),
	});
	const previewRevoke = useMutation({
		mutationFn: (shareId: string) =>
			osApi.osShares.shares.previewRevoke({ shareId }),
		onSuccess: (result) =>
			setConfirmOff({
				shareId: result.share.id,
				activeSessionCount: result.activeSessionCount,
			}),
	});
	// Turning a link off keeps its address: the same id comes back on.
	const setDisabled = useMutation({
		mutationFn: (input: { shareId: string; disabled: boolean }) =>
			osApi.osShares.shares.setDisabled(input),
		onSuccess: () => {
			setConfirmOff(null);
			setStaged(null);
		},
		onSettled: () => void invalidate(),
	});
	// "Delete link" is the permanent one: it removes the row for good, so a
	// new link mints a new id — unlike turning the link off.
	const deleteLink = useMutation({
		mutationFn: (shareId: string) => osApi.osShares.shares.delete({ shareId }),
		onSuccess: () => {
			setConfirmDelete(null);
			setConfirmOff(null);
			setStaged(null);
		},
		onSettled: () => void invalidate(),
	});
	const busy =
		createLink.isPending ||
		changeAccess.isPending ||
		updateSettings.isPending ||
		previewRevoke.isPending ||
		setDisabled.isPending ||
		deleteLink.isPending;
	const localEvaluation =
		typeof window !== "undefined" &&
		__LOCAL_DEMO_ENABLED__ &&
		resolveOsTenant(window.location.hostname).kind === "local";
	const editing = formMode.kind === "settings" ? formMode.share : null;
	const error =
		createLink.error ??
		changeAccess.error ??
		updateSettings.error ??
		setDisabled.error ??
		deleteLink.error ??
		previewRevoke.error;
	const chooseAccess = (option: OsShareAccess) => {
		if (!link) setStaged(option);
		else if (option !== link.access)
			changeAccess.mutate({ shareId: link.id, access: option });
	};
	const rowProps = (share: OsShareLink) => ({
		share,
		onRevoke: (shareId: string) => previewRevoke.mutate(shareId),
		revoking: busy,
		confirmRevoke:
			confirmOff?.shareId === share.id
				? { activeSessionCount: confirmOff.activeSessionCount }
				: null,
		onConfirmRevoke: (shareId: string) =>
			setDisabled.mutate({ shareId, disabled: true }),
		onCancelRevoke: () => setConfirmOff(null),
	});

	return (
		<div className="grid gap-4" data-share-links>
			{localEvaluation && (
				<Surface
					className="m-0 px-3 py-2 text-kumo-subtle text-xs"
					render={<p />}
				>
					Links made here only work on this local copy of Tedix.
				</Surface>
			)}
			<section className="grid gap-2" aria-label="Access" data-share-access>
				<Text as="h3" role="label" tone="strong" className="m-0">
					Who can open it
				</Text>
				<div
					role="radiogroup"
					aria-label="Who can open it"
					className="grid gap-1"
				>
					{OsShareAccessSchema.options.map((option) => {
						const selected = option === access;
						const Icon = ACCESS_ICON[option];
						return (
							<Button
								key={option}
								type="button"
								role="radio"
								aria-checked={selected}
								variant={selected ? "secondary" : "ghost"}
								className="w-full justify-start"
								disabled={busy || !shares.isSuccess}
								onClick={() => chooseAccess(option)}
								data-share-access-option={option}
							>
								<Icon size={16} aria-hidden className="shrink-0" />
								<span className="min-w-0 flex-1 truncate text-left">
									{accessLabel(option, organization)}
								</span>
								{selected ? (
									<Check size={14} aria-hidden className="shrink-0" />
								) : null}
							</Button>
						);
					})}
				</div>
				{access === "anyone_with_link" && shares.data?.guestRefusal ? (
					<Surface
						className="m-0 grid gap-2 px-3 py-2 text-kumo-subtle text-xs"
						data-guest-refusal={shares.data.guestRefusal.reason}
					>
						<p className="m-0">
							{guestRefusalText(shares.data.guestRefusal, organization)}
						</p>
						{shares.data.guestRefusal.reason === "not_runtime_app" ? (
							<div>
								<Button
									size="sm"
									variant="secondary"
									disabled={busy || !shares.isSuccess}
									onClick={() => chooseAccess("organization")}
									data-guest-refusal-switch
								>
									<Buildings size={14} aria-hidden /> Use People in{" "}
									{organization}
								</Button>
							</div>
						) : null}
					</Surface>
				) : null}
			</section>
			{link ? (
				<section
					className="grid gap-2"
					aria-label="Link"
					data-share-link-current
				>
					<div className="flex min-w-0 items-center gap-1">
						<div className="min-w-0 flex-1">
							<PermanentUrl url={link.url} off={linkOff} />
						</div>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Link options"
										disabled={busy}
									/>
								}
							>
								<DotsThree size={16} weight="bold" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{canEditSettings ? (
									<DropdownMenuItem
										onClick={() =>
											setFormMode({ kind: "settings", share: link })
										}
									>
										<PencilSimple size={14} /> Edit settings
									</DropdownMenuItem>
								) : null}
								{linkOff ? (
									<DropdownMenuItem
										onClick={() =>
											setDisabled.mutate({ shareId: link.id, disabled: false })
										}
									>
										<LinkSimple size={14} /> Turn on link
									</DropdownMenuItem>
								) : (
									<DropdownMenuItem
										onClick={() => previewRevoke.mutate(link.id)}
									>
										<Prohibit size={14} /> Turn off link
									</DropdownMenuItem>
								)}
								{canEditSettings ? (
									<DropdownMenuItem
										variant="destructive"
										onClick={() => setConfirmDelete(link.id)}
									>
										<Prohibit size={14} /> Delete link
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					{linkOff ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="secondary"
								loading={setDisabled.isPending}
								disabled={busy}
								onClick={() =>
									setDisabled.mutate({ shareId: link.id, disabled: false })
								}
								data-share-turn-on
							>
								<LinkSimple size={14} /> Turn link back on
							</Button>
							<Text role="label" tone="secondary" className="m-0">
								The link is off. The address is kept — turning it back on
								revives the same one.
							</Text>
						</div>
					) : null}
				</section>
			) : shares.isSuccess && formMode.kind === "closed" ? (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						loading={createLink.isPending}
						disabled={busy}
						onClick={() =>
							createLink.mutate({
								role: defaultRole,
								revisionMode: "living",
								note: "",
								expiresAt: null,
							})
						}
					>
						<LinkSimple size={14} /> Create link
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => setFormMode({ kind: "create" })}
					>
						More options
					</Button>
				</div>
			) : null}
			{shares.isPending && (
				<Text role="label" tone="secondary" className="m-0">
					Loading link…
				</Text>
			)}
			{shares.isError && (
				<Text role="label" tone="error" className="m-0">
					{shareErrorText(shares.error, "Can't load the link right now.")}
				</Text>
			)}
			{link?.access === "invited" ? <InviteList shareId={link.id} /> : null}
			{link && confirmOff?.shareId === link.id ? (
				<Alert variant="warning" data-share-turn-off>
					<Prohibit aria-hidden />
					<AlertTitle>Turn off this link?</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>
							It stops working right away but keeps its address — you can turn
							it back on any time.{" "}
							{confirmOff.activeSessionCount === 0
								? "Nobody has it open now."
								: `${confirmOff.activeSessionCount} ${
										confirmOff.activeSessionCount === 1
											? "person has"
											: "people have"
									} it open now and will lose access.`}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="destructive"
								loading={setDisabled.isPending}
								onClick={() =>
									setDisabled.mutate({ shareId: link.id, disabled: true })
								}
							>
								Turn off link
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setConfirmOff(null)}
							>
								Keep link
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{link && confirmDelete === link.id ? (
				<Alert variant="warning" data-share-delete>
					<Prohibit aria-hidden />
					<AlertTitle>Delete this link?</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>
							The address stops working for good — unlike turning the link off,
							this can't be undone. A new link would get a new address.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="destructive"
								loading={deleteLink.isPending}
								onClick={() => deleteLink.mutate(link.id)}
							>
								Delete link
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setConfirmDelete(null)}
							>
								Keep link
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{listedLinks.length > 1 ? (
				<section className="grid gap-1" aria-label="Other links">
					<Text as="h3" role="label" tone="strong" className="m-0">
						Other links
					</Text>
					<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
						{listedLinks.slice(1).map((share) => (
							<ShareRow key={share.id} {...rowProps(share)} />
						))}
					</ul>
				</section>
			) : null}
			{formMode.kind === "create" || editing ? (
				<LinkForm
					key={editing?.id ?? "create"}
					resourceType={resourceType}
					noun={noun}
					cannotPinRevision={cannotPinRevision}
					editing={editing}
					pending={editing ? updateSettings.isPending : createLink.isPending}
					initial={
						editing
							? {
									role: editing.role,
									revisionMode: editing.revisionMode,
									note: editing.note ?? "",
									expiresAt: editing.expiresAt
										? new Date(editing.expiresAt)
										: null,
								}
							: {
									role: defaultRole,
									revisionMode: "living",
									note: "",
									expiresAt: null,
								}
					}
					onSubmit={(settings) =>
						editing
							? updateSettings.mutate({ share: editing, settings })
							: createLink.mutate(settings)
					}
					onCancel={() => setFormMode({ kind: "closed" })}
				/>
			) : null}
			{error ? (
				<p className="m-0 text-kumo-danger text-xs" role="alert">
					{shareErrorText(error, "Couldn't change the link.")}
				</p>
			) : null}
			<Text role="label" tone="secondary" className="m-0" data-share-explainer>
				{accessHint(access, organization)}
				{link
					? ` ${ROLE_LABEL[link.role]} · ${revisionModeLabel(link.revisionMode).toLowerCase()} · ${shareExpiryLabel(link)}${link.note ? ` · ${link.note}` : ""}.`
					: ""}
			</Text>
			{resourceType === "gadget" && props.onOpenReview && (
				<ReviewEntry onOpen={props.onOpenReview} />
			)}
		</div>
	);
}

/**
 * The one Share button every shareable thing uses: files, documents,
 * sheets, slides, apps and workspaces. Compact is the icon alone.
 */
export function ShareButton(props: {
	compact?: boolean;
	/** Text of the full-size button; "Share" by default. */
	label?: string;
	/** Tooltip for the compact button; "Share" by default. */
	title?: string;
	expanded?: boolean;
	onClick: () => void;
}) {
	const label = props.label ?? "Share";
	// The explicit tabIndex keeps the trigger in WebKit's Tab order.
	return props.compact ? (
		<Button
			type="button"
			tabIndex={0}
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			title={props.title ?? label}
			aria-haspopup="dialog"
			aria-expanded={props.expanded}
			onClick={props.onClick}
			data-share-button
		>
			<ShareNetwork size={16} />
			<span className="sr-only">{label}</span>
		</Button>
	) : (
		<Button
			type="button"
			tabIndex={0}
			variant="secondary"
			size="sm"
			aria-haspopup="dialog"
			aria-expanded={props.expanded}
			onClick={props.onClick}
			data-share-button
		>
			<ShareNetwork size={14} /> {label}
		</Button>
	);
}

/**
 * A Share button that opens the links panel in its own dialog, for pages
 * without a workspace Share dialog (the file library and file detail).
 */
export function ShareControls(props: ShareControlsProps) {
	const { resourceType } = normalizeResource(props);
	const [open, setOpen] = useState(false);
	const noun = RESOURCE_NOUN[resourceType];
	const { compact, label, onOpenReview, ...panelProps } = props;
	return (
		<>
			<ShareButton
				compact={compact}
				label={label}
				expanded={open}
				onClick={() => setOpen(true)}
			/>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent size="sm" className={SHARE_DIALOG_CLASS}>
					<DialogHeader>
						<DialogTitle>Share this {noun}</DialogTitle>
					</DialogHeader>
					{open ? (
						<ShareLinksPanel
							{...(panelProps as ShareLinksPanelProps)}
							onOpenReview={
								onOpenReview
									? () => {
											setOpen(false);
											onOpenReview();
										}
									: undefined
							}
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}

/** On phones, Share is a near full-height sheet so its sections fit. */
export const SHARE_DIALOG_CLASS =
	"max-sm:max-h-[calc(var(--viewport-tedix-height)-0.5rem)]";
