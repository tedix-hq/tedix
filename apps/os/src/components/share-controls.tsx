import {
	CaretRight,
	Copy,
	LinkSimple,
	PencilSimple,
	Plus,
	Prohibit,
	User,
	UsersThree,
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
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import {
	PopoverContent,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osSharesQueryOptions,
	userProfileQueryOptions,
	workspaceDetailQueryOptions,
} from "@/lib/os-query-options";
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
	build: "Can edit",
};

const ROLE_VERB: Record<OsShareRole, string> = {
	viewer: "view",
	use: "use",
	build: "edit",
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

export function ShareRow(props: {
	share: OsShareLink;
	onRevoke?: (shareId: string) => void;
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
	return (
		<li className="grid gap-2 py-2" data-share-row>
			<div className="flex items-start gap-2">
				<LinkSimple size={14} className="mt-0.5 shrink-0 text-kumo-subtle" />
				<div className="grid min-w-0 flex-1 gap-0.5">
					<Text
						as="span"
						role="body"
						tone={active ? "strong" : "secondary"}
						className="m-0 truncate"
					>
						{props.share.note || "Link"}
					</Text>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="m-0"
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
			</div>
			{props.share.policyMaxRole && (
				<Text as="span" role="label" tone="warning" className="m-0 pl-6">
					Your organization limits this link to{" "}
					{ROLE_LABEL[props.share.policyMaxRole].toLowerCase()}:{" "}
					{props.share.policyReason}
				</Text>
			)}
			{props.editing && (
				<Text as="span" role="label" tone="secondary" className="m-0 pl-5">
					Editing below
				</Text>
			)}
			{active &&
				!confirm &&
				!props.editing &&
				(props.onEdit || props.onRevoke) && (
					<div className="flex flex-wrap gap-1 pl-5">
						{props.onEdit && (
							<Button
								variant="ghost"
								size="sm"
								disabled={props.revoking}
								onClick={() => props.onEdit?.(props.share)}
								aria-label="Edit this link"
							>
								<PencilSimple size={14} /> Edit
							</Button>
						)}
						{props.onRevoke && (
							<Button
								variant="ghost"
								size="sm"
								disabled={props.revoking}
								onClick={() => props.onRevoke?.(props.share.id)}
								aria-label="Turn off this link"
							>
								<Prohibit size={14} /> Turn off
							</Button>
						)}
					</div>
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

function NewLink(props: {
	token: string;
	base: string;
	role: OsShareRole;
	resourceType: OsShareResourceType;
	replaced: "none" | "off" | "still-on";
	onDismiss: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const url = formatShareLink(props.token, props.base);
	return (
		<Surface className="grid gap-2 p-3" data-share-new-link>
			<Text as="span" role="label" tone="strong" className="m-0">
				{props.replaced === "none"
					? "Your link is ready"
					: "Your new link is ready"}
			</Text>
			<Text
				as="code"
				role="label"
				tone="strong"
				className="m-0 select-all break-all rounded-md bg-kumo-recessed px-2 py-1.5 font-mono"
				aria-label="Share link URL"
				data-share-url
			>
				{url}
			</Text>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					autoFocus
					onClick={() => {
						navigator.clipboard?.writeText(url).then(
							() => setCopied(true),
							() => setCopied(false),
						);
					}}
				>
					<Copy size={14} /> {copied ? "Copied" : "Copy link"}
				</Button>
				<Button variant="ghost" size="sm" onClick={props.onDismiss}>
					Done
				</Button>
			</div>
			<Text role="label" tone="secondary" className="m-0">
				Anyone with this link can {ROLE_VERB[props.role]} this{" "}
				{RESOURCE_NOUN[props.resourceType]}. Copy it now: for safety it is shown
				only once.
				{props.replaced === "off" ? " The old link no longer works." : ""}
				{props.replaced === "still-on"
					? " The old link is still on: turn it off below."
					: ""}{" "}
				Your connected accounts are never shared.
			</Text>
		</Surface>
	);
}

/** Who can open a workspace, and everything in it, without a link. */
export type WorkspaceAccessRow = {
	key: string;
	name: string;
	role: "Owner" | "Can edit";
};

export function workspaceAccessRows(input: {
	visibility: "org" | "private";
	ownerUserId: string | null;
	createdById: string;
	viewerUserId: string | null;
	organizationName: string;
}): WorkspaceAccessRow[] {
	const ownerId =
		input.visibility === "private" ? input.ownerUserId : input.createdById;
	const viewerOwns = ownerId !== null && ownerId === input.viewerUserId;
	const rows: WorkspaceAccessRow[] = [
		{
			key: "owner",
			name: viewerOwns ? "You" : "The workspace owner",
			role: "Owner",
		},
	];
	if (input.visibility === "org")
		rows.push({
			key: "organization",
			name: `Everyone in ${input.organizationName}`,
			role: "Can edit",
		});
	return rows;
}

function PeopleWithAccess(props: { workspaceId: string; noun: string }) {
	const workspace = useQuery(workspaceDetailQueryOptions(props.workspaceId));
	const profile = useQuery(userProfileQueryOptions());
	const context = useOsOperationalContext();
	const detail = workspace.data?.workspace;
	const organization = context.data?.organization.name ?? "your organization";
	const canInvite =
		context.data?.authority.permissions.includes("team:manage") === true;
	return (
		<section className="grid gap-2" data-share-people>
			<Text as="h3" role="label" tone="strong" className="m-0">
				People with access
			</Text>
			{detail ? (
				<ul className="m-0 grid list-none gap-0.5 p-0">
					{workspaceAccessRows({
						visibility: detail.visibility,
						ownerUserId: detail.ownerUserId,
						createdById: detail.createdById,
						viewerUserId: profile.data?.id ?? null,
						organizationName: organization,
					}).map((row) => (
						<li key={row.key} className="flex items-center gap-2 py-1">
							{row.key === "organization" ? (
								<UsersThree size={14} className="shrink-0 text-kumo-subtle" />
							) : (
								<User size={14} className="shrink-0 text-kumo-subtle" />
							)}
							<Text as="span" role="body" className="min-w-0 flex-1 truncate">
								{row.name}
							</Text>
							<Badge variant="secondary">{row.role}</Badge>
						</li>
					))}
				</ul>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					{workspace.isError
						? "Can't load who has access right now."
						: "Loading who has access…"}
				</Text>
			)}
			<Text role="label" tone="secondary" className="m-0">
				{detail?.visibility === "private"
					? `Private workspace: no one else in ${organization} can open this ${props.noun}.`
					: props.noun === "workspace"
						? `Every member of ${organization} can open it.`
						: `Everyone who can open its workspace can open this ${props.noun}.`}{" "}
				{canInvite ? (
					<Link href="/team?tab=members">Invite people to {organization}</Link>
				) : null}
			</Text>
		</section>
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
	pending: boolean;
	onSubmit: (settings: LinkSettings) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState<LinkSettings>(props.initial);
	const set = (patch: Partial<LinkSettings>) =>
		setSettings((current) => ({ ...current, ...patch }));
	const cannotPin = props.cannotPinRevision && !props.editing?.pinnedRevisionId;
	return (
		<div className="grid gap-4" data-share-form>
			{props.editing && (
				<Text as="h3" role="label" tone="strong" className="m-0">
					Edit “{props.editing.note || "Link"}”
				</Text>
			)}
			{props.resourceType !== "output" && (
				<ShareField
					as="div"
					label="People with the link can"
					hint="Use: they can use the app but not see how it is built. Edit: they also need their own Tedix access."
				>
					<SegmentedControl
						ariaLabel="Share access role"
						fill
						value={settings.role as "use" | "build"}
						onValueChange={(role) => set({ role })}
						options={[
							{ value: "use", label: "Use the app" },
							{ value: "build", label: "Edit the workspace" },
						]}
					/>
				</ShareField>
			)}
			<ShareField
				as="div"
				label="Link shows"
				hint={
					cannotPin
						? `Save this ${props.noun} first to share a fixed version.`
						: "Latest version follows your changes. This version stays as it is now."
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
			<ShareField
				as="div"
				label="Expires (optional)"
				hint="Leave empty to keep the link until you turn it off."
			>
				<DateTimePicker
					aria-label="Link expiry"
					value={settings.expiresAt}
					onChange={(expiresAt) => set({ expiresAt })}
					min={new Date()}
					placeholder="Never"
				/>
			</ShareField>
			{props.editing && (
				<Text role="label" tone="secondary" className="m-0">
					Saving gives you a new link to send. The old one stops working
					{props.editing.resourceType === "gadget" &&
					props.editing.role === "use"
						? ", and so does any review sent with it."
						: "."}
				</Text>
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
					{props.editing ? (
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
		</div>
	);
}

/** Review rounds live in the app's Review tab; Share only points there. */
function ReviewEntry(props: { onOpen: () => void }) {
	const context = useOsOperationalContext();
	// The API lets only the organization owner send a round.
	if (context.data?.authority.role !== "owner") return null;
	return (
		<div className="border-kumo-line border-t pt-3">
			<Button
				variant="ghost"
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

type ShareControlsProps = (
	| { outputId: string; currentRevisionId?: string | null }
	| {
			resourceType: "gadget" | "workspace";
			resourceId: string;
			currentRevisionId?: string | null;
	  }
) & {
	compact?: boolean;
	/** Text of the full-size trigger; "Share" by default. */
	label?: string;
	/** The workspace holding this resource; shows who can open it without a link. */
	workspaceId?: string;
	/**
	 * The app runs its own code, so a `use` link opens for anyone on the
	 * account-free guest page instead of the signed-in share page.
	 */
	guestEntry?: boolean;
	/** Opens the app's Review tab, where review rounds are sent. */
	onOpenReview?: () => void;
};

function normalizeResource(props: ShareControlsProps): {
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
	| { kind: "edit"; share: OsShareLink };

export function ShareControls(props: ShareControlsProps) {
	const { resourceType, resourceId, currentRevisionId } =
		normalizeResource(props);
	const [open, setOpen] = useState(false);
	const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
	const [showInactive, setShowInactive] = useState(false);
	const [revokeImpact, setRevokeImpact] = useState<{
		shareId: string;
		activeSessionCount: number;
	} | null>(null);
	const queryClient = useQueryClient();
	const sharesQuery = osSharesQueryOptions({ resourceType, resourceId });
	const shares = useQuery({
		...sharesQuery,
		enabled: open,
	});
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
	// With no working link yet, the form is the whole point of opening Share.
	const formOpen =
		formMode.kind !== "closed" ||
		(shares.isSuccess && activeLinks.length === 0 && !created);
	const editing = formMode.kind === "edit" ? formMode.share : null;
	const defaultRole: OsShareRole = resourceType === "output" ? "viewer" : "use";
	const rowProps = (share: OsShareLink) => ({
		share,
		onEdit: (target: OsShareLink) => {
			setRevokeImpact(null);
			saveLink.reset();
			setFormMode({ kind: "edit", share: target });
		},
		onRevoke: (shareId: string) => previewRevoke.mutate(shareId),
		revoking: previewRevoke.isPending || revokeShare.isPending,
		confirmRevoke:
			revokeImpact?.shareId === share.id
				? { activeSessionCount: revokeImpact.activeSessionCount }
				: null,
		onConfirmRevoke: (shareId: string) => revokeShare.mutate(shareId),
		onCancelRevoke: () => setRevokeImpact(null),
		editing: formMode.kind === "edit" && formMode.share.id === share.id,
	});

	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					props.compact ? (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Share"
							title="Share"
						>
							<LinkSimple size={14} />
							<span className="sr-only">Share</span>
						</Button>
					) : (
						<Button variant="secondary" size="sm">
							<LinkSimple size={14} /> {props.label ?? "Share"}
						</Button>
					)
				}
			/>
			<PopoverContent
				side="bottom"
				align="end"
				className="grid max-h-[min(var(--available-height),calc(var(--viewport-tedix-height)-2rem))] w-[min(26rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
			>
				<PopoverTitle className="m-0 font-semibold text-base text-kumo-default">
					Share this {noun}
				</PopoverTitle>
				{localEvaluation && (
					<Surface
						className="m-0 px-3 py-2 text-kumo-subtle text-xs"
						render={<p />}
					>
						Links made here only work on this local copy of Tedix.
					</Surface>
				)}
				{props.workspaceId && open ? (
					<PeopleWithAccess workspaceId={props.workspaceId} noun={noun} />
				) : null}
				<section
					className={
						props.workspaceId
							? "grid gap-2 border-kumo-line border-t pt-4"
							: "grid gap-2"
					}
					data-share-links
				>
					<Text as="h3" role="label" tone="strong" className="m-0">
						Links
					</Text>
					{props.guestEntry && shares.data?.guestRefusal && (
						<Surface
							className="m-0 px-3 py-2 text-kumo-subtle text-xs"
							render={<p />}
							data-guest-refusal={shares.data.guestRefusal.reason}
						>
							{guestRefusalText(shares.data.guestRefusal)}
						</Surface>
					)}
					{created && (
						<NewLink
							token={created.token}
							base={
								props.guestEntry &&
								resourceType === "gadget" &&
								created.share.role === "use" &&
								typeof window !== "undefined"
									? `${window.location.origin}/guest`
									: shareBase
							}
							role={created.share.role}
							resourceType={resourceType}
							replaced={created.replaced}
							onDismiss={() => saveLink.reset()}
						/>
					)}
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
					{shares.isSuccess && activeLinks.length === 0 && (
						<Text role="label" tone="secondary" className="m-0">
							No links yet. Make one to let people outside this workspace{" "}
							{ROLE_VERB[defaultRole]} this {noun}.
						</Text>
					)}
					{activeLinks.length > 0 && (
						<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
							{activeLinks.map((share) => (
								<ShareRow key={share.id} {...rowProps(share)} />
							))}
						</ul>
					)}
					{activeLinks.length > 0 && (
						<Text role="label" tone="secondary" className="m-0">
							For safety, a link is shown only once. Lost one? Edit it to get a
							new link.
						</Text>
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
				</section>
				{formOpen ? (
					<div className="border-kumo-line border-t pt-4">
						<LinkForm
							key={editing?.id ?? "create"}
							resourceType={resourceType}
							noun={noun}
							cannotPinRevision={cannotPinRevision}
							editing={editing}
							pending={saveLink.isPending}
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
								saveLink.mutate({ settings, replaces: editing })
							}
							onCancel={
								activeLinks.length > 0 || created
									? () => setFormMode({ kind: "closed" })
									: undefined
							}
						/>
					</div>
				) : (
					shares.isSuccess && (
						<Button
							variant="secondary"
							className="w-full justify-center"
							onClick={() => {
								setRevokeImpact(null);
								saveLink.reset();
								setFormMode({ kind: "create" });
							}}
						>
							<Plus size={14} /> New link
						</Button>
					)
				)}
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
				{(saveLink.isError || revokeShare.isError || previewRevoke.isError) && (
					<p className="m-0 text-kumo-danger text-xs" role="alert">
						{saveLink.isError
							? `Couldn't ${saveLink.variables?.replaces ? "save" : "create"} the link. ${(saveLink.error as Error).message}`
							: revokeShare.isError
								? `Couldn't turn off the link. ${(revokeShare.error as Error).message}`
								: `Couldn't check this link. ${(previewRevoke.error as Error).message}`}
					</p>
				)}
				{resourceType === "gadget" && props.onOpenReview && (
					<ReviewEntry
						onOpen={() => {
							setOpen(false);
							props.onOpenReview?.();
						}}
					/>
				)}
			</PopoverContent>
		</PopoverRoot>
	);
}
