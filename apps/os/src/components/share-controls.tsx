import {
	CaretRight,
	Copy,
	ArrowsClockwise,
	DotsThree,
	Globe,
	LinkSimple,
	Lock,
	PencilSimple,
	Prohibit,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsShareLink,
	OsShareResourceType,
	OsShareRevisionMode,
	OsShareRole,
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
import { osApi } from "@/lib/api";
import { osSharesQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

export const SHARE_LINK_BASE = "https://api.tedix.dev/os-shared";
declare const __LOCAL_DEMO_ENABLED__: boolean;

export function formatShareLink(
	token: string,
	base: string = SHARE_LINK_BASE,
): string {
	return `${base}#token=${encodeURIComponent(token)}`;
}

export function shareLinkBase(input: {
	resourceType: OsShareResourceType;
	origin: string;
	localEvaluation: boolean;
}): string {
	return input.localEvaluation || input.resourceType !== "output"
		? `${input.origin}/shared`
		: SHARE_LINK_BASE;
}

export type ShareLinkStatus = "active" | "expired" | "revoked";

export function shareStatus(
	share: Pick<OsShareLink, "expiresAt" | "revokedAt">,
	now: Date = new Date(),
): ShareLinkStatus {
	if (share.revokedAt !== null) return "revoked";
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
	share: Pick<OsShareLink, "expiresAt" | "revokedAt">,
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
	expired: "Expired",
	revoked: "Turned off",
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
 * One link: what it allows, in one line, and a quiet menu for the rest. The
 * URL itself is never shown again, so the menu offers Edit settings (same
 * link), Get a new link, and Turn off.
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

/** The one-time URL, shown right where the link was made. */
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
	editing: OsShareLink | null;
	/** Edit the link in place: same URL, so the version it shows stays. */
	inPlace?: boolean;
	pending: boolean;
	onSubmit: (settings: LinkSettings) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState<LinkSettings>(props.initial);
	const set = (patch: Partial<LinkSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const cannotPin = props.cannotPinRevision && !props.editing?.pinnedRevisionId;
	return (
		<Surface className="grid gap-4 p-3" data-share-form>
			<Text as="h3" role="label" tone="strong" className="m-0">
				{props.editing
					? props.inPlace
						? `Settings for “${props.editing.note || "Link"}”`
						: `New link for “${props.editing.note || "Link"}”`
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
			{props.inPlace ? null : (
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
			{props.inPlace ? (
				<Text role="label" tone="secondary" className="m-0">
					The link stays the same; people who have it see the new settings.
				</Text>
			) : (
				props.editing && (
					<Text role="label" tone="secondary" className="m-0">
						Saving gives you a new link. The old one stops working
						{props.editing.resourceType === "gadget" &&
						props.editing.role === "use"
							? ", and so does any review sent with it."
							: "."}
					</Text>
				)
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					className="flex-1 justify-center"
					loading={props.pending}
					disabled={
						props.pending || (settings.revisionMode === "pinned" && cannotPin)
					}
					onClick={() => props.onSubmit(settings)}
				>
					{props.inPlace ? (
						"Save"
					) : props.editing ? (
						"Save and get new link"
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
	/**
	 * The app runs its own code, so a `use` link opens for anyone on the
	 * account-free guest page instead of the signed-in share page.
	 */
	guestEntry?: boolean;
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

/** Why a "Can use" link will not open this app for people without a Tedix account. */
function guestRefusalText(refusal: {
	slot: string;
	reason: "connection_grant" | "unshared_output";
}): string {
	const why =
		refusal.reason === "connection_grant"
			? `it can reach a connected account through "${refusal.slot}"`
			: `"${refusal.slot}" is not a Tedix Output, or its Output holds data from connected accounts`;
	return `People without a Tedix account can't open this app through a link: ${why}, and Tedix can't check what they may see there. Invite them to the workspace instead, or remove that access from the app.`;
}

type FormMode =
	| { kind: "closed" }
	| { kind: "create" }
	| { kind: "edit"; share: OsShareLink }
	| { kind: "settings"; share: OsShareLink };

/** Changing a live link in place is for organization owners and admins. */
function useCanEditLinkSettings(): boolean {
	const permissions: readonly string[] =
		useOsOperationalContext().data?.authority.permissions ?? [];
	return (
		permissions.includes("os:admin") || permissions.includes("settings:manage")
	);
}

/** The General access choices: no link, or a link at one role. */
type AccessChoice = "restricted" | `link:${OsShareRole}`;

function accessRoles(resourceType: OsShareResourceType): OsShareRole[] {
	return resourceType === "output" ? ["viewer"] : ["use", "build"];
}

/**
 * Links to one app or file: a General access row that makes or turns off a
 * link, the one-time URL right under it, and the list of links each with a
 * quiet menu. It has no surface of its own, so it sits inside the workspace
 * Share dialog or inside ShareControls' own dialog.
 */
export function ShareLinksPanel(props: ShareLinksPanelProps) {
	const { resourceType, resourceId, currentRevisionId } =
		normalizeResource(props);
	const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
	const [showInactive, setShowInactive] = useState(false);
	const [revokeImpact, setRevokeImpact] = useState<{
		shareId: string;
		activeSessionCount: number;
	} | null>(null);
	const queryClient = useQueryClient();
	const sharesQuery = osSharesQueryOptions({ resourceType, resourceId });
	const shares = useQuery(sharesQuery);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey });
	const saveLink = useMutation({
		mutationFn: async (input: {
			settings: LinkSettings;
			replaces: OsShareLink | null;
		}) => {
			const { role, revisionMode, note, expiresAt } = input.settings;
			const pinnedRevisionId =
				revisionMode === "pinned" && resourceType !== "workspace"
					? (input.replaces?.pinnedRevisionId ?? currentRevisionId)
					: null;
			const created = await osApi.osShares.shares.create({
				resourceType,
				resourceId,
				role,
				revisionMode,
				...(pinnedRevisionId ? { pinnedRevisionId } : {}),
				...(note.trim() ? { note: note.trim() } : {}),
				...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
			});
			// The new link exists before the old one stops, so a failed turn-off
			// never leaves the owner with no working link, and the one-time URL
			// is still shown.
			if (!input.replaces) return { ...created, replaced: "none" as const };
			try {
				await osApi.osShares.shares.revoke({ shareId: input.replaces.id });
				return { ...created, replaced: "off" as const };
			} catch {
				return { ...created, replaced: "still-on" as const };
			}
		},
		onSuccess: () => setFormMode({ kind: "closed" }),
		onSettled: () => void invalidate(),
	});
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
	const canEditSettings = useCanEditLinkSettings();
	const previewRevoke = useMutation({
		mutationFn: (shareId: string) =>
			osApi.osShares.shares.previewRevoke({ shareId }),
		onSuccess: (result) =>
			setRevokeImpact({
				shareId: result.share.id,
				activeSessionCount: result.activeSessionCount,
			}),
	});
	const revokeShare = useMutation({
		mutationFn: (shareId: string) => osApi.osShares.shares.revoke({ shareId }),
		onSuccess: () => {
			setRevokeImpact(null);
			void invalidate();
		},
	});
	const localEvaluation =
		typeof window !== "undefined" &&
		__LOCAL_DEMO_ENABLED__ &&
		resolveOsTenant(window.location.hostname).kind === "local";
	const shareBase =
		typeof window === "undefined"
			? SHARE_LINK_BASE
			: shareLinkBase({
					resourceType,
					origin: window.location.origin,
					localEvaluation,
				});
	const noun = RESOURCE_NOUN[resourceType];
	const cannotPinRevision =
		resourceType !== "workspace" && currentRevisionId === null;
	const items = shares.data?.items ?? [];
	const activeLinks = items.filter((share) => shareStatus(share) === "active");
	const inactiveLinks = items.filter(
		(share) => shareStatus(share) !== "active",
	);
	const created = saveLink.data;
	const editing =
		formMode.kind === "edit" || formMode.kind === "settings"
			? formMode.share
			: null;
	const inPlace = formMode.kind === "settings";
	const defaultRole: OsShareRole = resourceType === "output" ? "viewer" : "use";
	const newest = activeLinks[0] ?? null;
	const access: AccessChoice = newest ? `link:${newest.role}` : "restricted";
	const busy =
		saveLink.isPending ||
		updateSettings.isPending ||
		previewRevoke.isPending ||
		revokeShare.isPending;

	const openForm = (mode: FormMode) => {
		setRevokeImpact(null);
		saveLink.reset();
		updateSettings.reset();
		setFormMode(mode);
	};
	const chooseAccess = (choice: AccessChoice) => {
		if (choice === access) return;
		if (choice === "restricted") {
			if (newest) previewRevoke.mutate(newest.id);
			return;
		}
		const role = choice.slice("link:".length) as OsShareRole;
		setFormMode({ kind: "closed" });
		setRevokeImpact(null);
		saveLink.mutate({
			settings: { role, revisionMode: "living", note: "", expiresAt: null },
			replaces: null,
		});
	};
	const rowProps = (share: OsShareLink) => ({
		share,
		onEditSettings: canEditSettings
			? (target: OsShareLink) => openForm({ kind: "settings", share: target })
			: undefined,
		onEdit: (target: OsShareLink) => openForm({ kind: "edit", share: target }),
		onRevoke: (shareId: string) => previewRevoke.mutate(shareId),
		revoking: previewRevoke.isPending || revokeShare.isPending,
		confirmRevoke:
			revokeImpact?.shareId === share.id
				? { activeSessionCount: revokeImpact.activeSessionCount }
				: null,
		onConfirmRevoke: (shareId: string) => revokeShare.mutate(shareId),
		onCancelRevoke: () => setRevokeImpact(null),
		editing: editing?.id === share.id,
	});
	const createdUrl = created
		? formatShareLink(
				created.token,
				props.guestEntry &&
					resourceType === "gadget" &&
					created.share.role === "use" &&
					typeof window !== "undefined"
					? `${window.location.origin}/guest`
					: shareBase,
			)
		: null;

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
			<section className="grid gap-2" aria-label="General access">
				<Text as="h3" role="label" tone="strong" className="m-0">
					General access
				</Text>
				<div className="flex flex-wrap items-center gap-2">
					{access === "restricted" ? (
						<Lock size={16} className="shrink-0 text-kumo-subtle" />
					) : (
						<Globe size={16} className="shrink-0 text-kumo-subtle" />
					)}
					<Select
						value={access}
						onValueChange={(value) => chooseAccess(value as AccessChoice)}
					>
						<SelectTrigger
							aria-label="General access"
							className="min-w-0 flex-1"
							disabled={busy || !shares.isSuccess}
						>
							<SelectValue>
								{access === "restricted"
									? resourceType === "workspace"
										? "Only people invited"
										: "Only people in the workspace"
									: `Anyone with the link can ${ROLE_VERB[newest?.role ?? defaultRole]}`}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="restricted">
								{resourceType === "workspace"
									? "Only people invited"
									: "Only people in the workspace"}
							</SelectItem>
							{accessRoles(resourceType).map((role) => (
								<SelectItem key={role} value={`link:${role}`}>
									Anyone with the link can {ROLE_VERB[role]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Link options"
									disabled={busy || !shares.isSuccess}
								/>
							}
						>
							<DotsThree size={16} weight="bold" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => openForm({ kind: "create" })}>
								<LinkSimple size={14} /> New link with options
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				{props.guestEntry && shares.data?.guestRefusal && (
					<Surface
						className="m-0 px-3 py-2 text-kumo-subtle text-xs"
						render={<p />}
						data-guest-refusal={shares.data.guestRefusal.reason}
					>
						{guestRefusalText(shares.data.guestRefusal)}
					</Surface>
				)}
				{created && createdUrl ? (
					<FreshLink
						url={createdUrl}
						title={
							created.replaced === "none"
								? "Your link is ready"
								: "Your new link is ready"
						}
						note={`Anyone with this link can ${ROLE_VERB[created.share.role]} this ${noun}. Copy it now: it is shown only once.${
							created.replaced === "off" ? " The old link no longer works." : ""
						}${
							created.replaced === "still-on"
								? " The old link is still on: turn it off below."
								: ""
						}`}
						onDismiss={() => saveLink.reset()}
					/>
				) : null}
				{shares.isPending && (
					<Text role="label" tone="secondary" className="m-0">
						Loading links…
					</Text>
				)}
				{shares.isError && (
					<Text role="label" tone="error" className="m-0">
						{shareErrorText(shares.error, "Can't load links right now.")}
					</Text>
				)}
				{shares.isSuccess && activeLinks.length === 0 && !created ? (
					<Text role="label" tone="secondary" className="m-0">
						Pick “Anyone with the link” to get a link you can send.
					</Text>
				) : null}
			</section>
			{activeLinks.length > 0 && (
				<section className="grid gap-1" aria-label="Links">
					<Text as="h3" role="label" tone="strong" className="m-0">
						Links
					</Text>
					<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
						{activeLinks.map((share) => (
							<ShareRow key={share.id} {...rowProps(share)} />
						))}
					</ul>
					{!created ? (
						<Text role="label" tone="secondary" className="m-0">
							A link is shown only once. Lost one? Get a new link from its menu.
						</Text>
					) : null}
				</section>
			)}
			{inactiveLinks.length > 0 && (
				<div className="grid gap-1">
					<Button
						variant="ghost"
						size="sm"
						className="-mx-2 justify-start"
						onClick={() => setShowInactive((value) => !value)}
					>
						{showInactive ? "Hide" : "Show"} {inactiveLinks.length} old{" "}
						{inactiveLinks.length === 1 ? "link" : "links"}
					</Button>
					{showInactive && (
						<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
							{inactiveLinks.map((share) => (
								<ShareRow key={share.id} share={share} />
							))}
						</ul>
					)}
				</div>
			)}
			{formMode.kind !== "closed" ? (
				<LinkForm
					key={`${formMode.kind}:${editing?.id ?? "create"}`}
					resourceType={resourceType}
					noun={noun}
					cannotPinRevision={cannotPinRevision}
					editing={editing}
					inPlace={inPlace}
					pending={inPlace ? updateSettings.isPending : saveLink.isPending}
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
						inPlace && editing
							? updateSettings.mutate({ share: editing, settings })
							: saveLink.mutate({ settings, replaces: editing })
					}
					onCancel={() => setFormMode({ kind: "closed" })}
				/>
			) : null}
			{(saveLink.isPending || revokeShare.isPending) && (
				<p
					className="m-0 text-kumo-subtle text-xs"
					role="status"
					data-slot="share-pending"
				>
					{saveLink.isPending
						? editing
							? "Making the new link…"
							: "Creating link…"
						: "Turning off link…"}
				</p>
			)}
			{(saveLink.isError ||
				updateSettings.isError ||
				revokeShare.isError ||
				previewRevoke.isError) && (
				<p className="m-0 text-kumo-danger text-xs" role="alert">
					{updateSettings.isError
						? `Couldn't save the link settings. ${(updateSettings.error as Error).message}`
						: saveLink.isError
							? `Couldn't ${saveLink.variables?.replaces ? "save" : "create"} the link. ${(saveLink.error as Error).message}`
							: revokeShare.isError
								? `Couldn't turn off the link. ${(revokeShare.error as Error).message}`
								: `Couldn't check this link. ${(previewRevoke.error as Error).message}`}
				</p>
			)}
			{resourceType === "gadget" && props.onOpenReview && (
				<ReviewEntry onOpen={props.onOpenReview} />
			)}
		</div>
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
			{/* The explicit tabIndex keeps the trigger in WebKit's Tab order. */}
			{compact ? (
				<Button
					type="button"
					tabIndex={0}
					variant="ghost"
					size="icon-sm"
					aria-label="Share"
					title="Share"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => setOpen(true)}
				>
					<LinkSimple size={14} />
					<span className="sr-only">Share</span>
				</Button>
			) : (
				<Button
					type="button"
					tabIndex={0}
					variant="secondary"
					size="sm"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => setOpen(true)}
				>
					<LinkSimple size={14} /> {label ?? "Share"}
				</Button>
			)}
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
