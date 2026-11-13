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
import { type ReactNode, useEffect, useRef, useState } from "react";
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
	share: Pick<OsShareLink, "expiresAt" | "revokedAt" | "disabledAt"> &
		Pick<Partial<OsShareLink>, "stoppedByPrivateWorkspace">,
	now: Date = new Date(),
): ShareLinkStatus {
	if (share.revokedAt !== null) return "revoked";
	// A link from before "off" existed has no disabledAt at all; it is active.
	// A link its workspace's privacy stopped is off until turned back on.
	if (share.disabledAt || share.stoppedByPrivateWorkspace) return "off";
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

/** What the server says a change would do, before it is made. */
export type ShareImpact = Awaited<
	ReturnType<typeof osApi.osShares.shares.previewChange>
>;

/** A change to the main link the person asked for. */
type LinkChangeRequest = { shareId: string } & (
	| { kind: "access"; access: OsShareAccess; previous: OsShareAccess }
	| { kind: "off" }
	| { kind: "delete" }
);

/** That change with the server's preview, held until the person confirms. */
type PendingLinkChange = LinkChangeRequest & { impact: ShareImpact };

/** One invited person about to be removed, with what that does. */
type InviteeRemoval = {
	inviteeId: string;
	email: string | null;
	label: string;
	impact: ShareImpact;
};

function countPeople(count: number): string {
	return count === 1 ? "1 person" : `${count} people`;
}

/** "3 people and anyone with the link", or null when the set is empty. */
function audienceText(
	audience: ShareImpact["loses"],
	organization: string,
): string | null {
	const parts = [
		audience.people > 0 ? countPeople(audience.people) : null,
		audience.organization ? `people in ${organization}` : null,
		audience.anyoneWithLink ? "anyone with the link" : null,
	].filter((part): part is string => part !== null);
	if (parts.length === 0) return null;
	const text = new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(parts);
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** True when the change takes access away from someone. */
export function impactNarrows(impact: ShareImpact): boolean {
	return (
		impact.loses.people > 0 ||
		impact.loses.organization ||
		impact.loses.anyoneWithLink
	);
}

/**
 * The effect of a sharing change in plain sentences: who loses access, who
 * gains it, who is left, and who keeps it another way. The numbers are the
 * server's; `done` switches to the past tense for the notice after a change.
 */
export function shareImpactSentences(
	impact: ShareImpact,
	options: { noun: string; organization: string; done?: boolean },
): string[] {
	const { noun, organization, done } = options;
	const sentences: string[] = [];
	const loses = audienceText(impact.loses, organization);
	if (loses)
		sentences.push(
			done
				? `${loses} can no longer open this ${noun}.`
				: `${loses} will no longer be able to open this ${noun}.`,
		);
	const gains = audienceText(impact.gains, organization);
	if (gains)
		sentences.push(
			`${gains} ${done ? "can now" : "will be able to"} open this ${noun}${
				impact.gains.anyoneWithLink ? ", without signing in" : ""
			}.`,
		);
	if (done) return sentences;
	const left = loses ? audienceText(impact.remaining, organization) : null;
	if (left) sentences.push(`Still able to open it: ${left.toLowerCase()}.`);
	if (impact.keepThroughWorkspace > 0)
		sentences.push(
			`${countPeople(impact.keepThroughWorkspace)} on the invite list still ${
				impact.keepThroughWorkspace === 1 ? "opens" : "open"
			} it through the workspace.`,
		);
	if (impact.openNow > 0)
		sentences.push(
			impact.openNow === 1
				? "It is open in 1 place right now; that closes."
				: `It is open in ${impact.openNow} places right now; those close.`,
		);
	if (sentences.length === 0)
		sentences.push(`Nobody's access to this ${noun} changes.`);
	return sentences;
}

const UNDO_MS = 15_000;

/** What can be put back, for a short while after access was taken away. */
type UndoOffer = { text: string; run: () => Promise<unknown> };

/**
 * Holds one Undo offer for a short time. Undo runs the opposite change
 * through the same guarded calls, then clears itself.
 */
function useUndoOffer(onDone: () => void) {
	const [offer, setOffer] = useState<UndoOffer | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const show = (next: UndoOffer | null) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = next ? setTimeout(() => setOffer(null), UNDO_MS) : null;
		setOffer(next);
	};
	const undo = useMutation({
		mutationFn: (current: UndoOffer) => current.run(),
		onSuccess: () => show(null),
		onSettled: onDone,
	});
	return { offer, show, undo };
}

/** What was done, with Undo, right after access was taken away. */
function UndoNotice(props: { undo: ReturnType<typeof useUndoOffer> }) {
	const { offer, undo } = props.undo;
	if (!offer) return null;
	return (
		<Surface
			className="flex flex-wrap items-center gap-2 px-3 py-2"
			aria-live="polite"
			data-share-undo
		>
			<Text as="span" role="label" className="m-0 min-w-0 flex-1">
				{undo.isError ? "Couldn't undo that. Try again." : offer.text}
			</Text>
			<Button
				size="sm"
				variant="secondary"
				loading={undo.isPending}
				disabled={undo.isPending}
				onClick={() => undo.mutate(offer)}
			>
				Undo
			</Button>
		</Surface>
	);
}

/** The server's answer in sentences, inside a confirmation. */
function ImpactSentences(props: {
	impact: ShareImpact;
	noun: string;
	organization: string;
}) {
	return (
		<div className="grid gap-1" data-share-impact>
			{shareImpactSentences(props.impact, props).map((sentence) => (
				<p key={sentence} className="m-0">
					{sentence}
				</p>
			))}
		</div>
	);
}

const ROLE_LABEL: Record<OsShareRole, string> = {
	viewer: "Can view",
	use: "Can use",
	edit: "Can edit",
	build: "Can build",
};

const ROLE_VERB: Record<OsShareRole, string> = {
	viewer: "view",
	use: "use",
	edit: "edit",
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

export const COPY_FAILED_TEXT =
	"Couldn't copy the link. Select it and copy it yourself.";

const COPIED_RESET_MS = 2000;

export type LinkCopyState = "idle" | "copied" | "failed";

/**
 * Copies a link and says how it went: "copied" for about two seconds, or
 * "failed" until the next try, so the person knows to copy it by hand.
 */
export function useLinkCopy(): {
	state: LinkCopyState;
	copy: (url: string) => Promise<boolean>;
} {
	const [state, setState] = useState<LinkCopyState>("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const settle = (next: LinkCopyState) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current =
			next === "copied"
				? setTimeout(() => setState("idle"), COPIED_RESET_MS)
				: null;
		setState(next);
	};
	const copy = async (url: string) => {
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(url);
			settle("copied");
			return true;
		} catch {
			settle("failed");
			return false;
		}
	};
	return { state, copy };
}

/**
 * Announces a copy to screen readers and shows the failure to everyone. The
 * button already reads "Copied", so success stays hidden unless asked for.
 */
export function LinkCopyStatus(props: {
	state: LinkCopyState;
	showCopied?: boolean;
}) {
	const failed = props.state === "failed";
	const visible = failed || (props.showCopied && props.state === "copied");
	return (
		<Text
			as="span"
			role="label"
			tone={failed ? "error" : "secondary"}
			className={visible ? "m-0 block" : "sr-only"}
			aria-live="polite"
			data-link-copy-status={props.state}
		>
			{failed
				? COPY_FAILED_TEXT
				: props.state === "copied"
					? "Link copied"
					: ""}
		</Text>
	);
}

/** A link's address, shown right where the link was made. */
export function FreshLink(props: {
	url: string;
	title?: string;
	note?: string;
	onDismiss?: () => void;
}) {
	const { state, copy } = useLinkCopy();
	const copied = state === "copied";
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
				<Button size="sm" autoFocus onClick={() => void copy(props.url)}>
					<Copy size={14} /> {copied ? "Copied" : "Copy link"}
				</Button>
				{props.onDismiss ? (
					<Button variant="ghost" size="sm" onClick={props.onDismiss}>
						Done
					</Button>
				) : null}
			</div>
			<LinkCopyStatus state={state} />
			{props.note ? (
				<Text role="label" tone="secondary" className="m-0">
					{props.note}
				</Text>
			) : null}
		</Surface>
	);
}

/**
 * Whether the people invited to an app may change its files or only look.
 * Narrowing to view takes effect on their next save.
 */
function InvitedRole(props: {
	role: "use" | "edit";
	noun: string;
	pending: boolean;
	onChange: (role: "use" | "edit") => void;
}) {
	return (
		<ShareField
			as="div"
			label="Invited people can"
			hint={
				props.role === "edit"
					? `They can change this ${props.noun}'s files after confirming their email. Each change is saved under the link they used.`
					: `They can open this ${props.noun} but not change its files.`
			}
		>
			<div data-share-invited-role={props.role}>
				<SegmentedControl
					ariaLabel="What invited people can do"
					fill
					value={props.role}
					onValueChange={(role) => {
						if (role !== props.role && !props.pending) props.onChange(role);
					}}
					options={[
						{ value: "use", label: "View" },
						{ value: "edit", label: "Edit" },
					]}
				/>
			</div>
		</ShareField>
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
						value={settings.role as "use" | "edit" | "build"}
						onValueChange={(role) => set({ role })}
						options={[
							{ value: "use", label: "Use" },
							// Editing is for people the link names, one app at a time.
							...(props.resourceType === "gadget" &&
							props.editing?.access === "invited"
								? [{ value: "edit" as const, label: "Edit" }]
								: []),
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

/**
 * What an "Anyone with the link" workspace link leaves out, in plain words,
 * or null when it shows everything.
 */
export function workspaceGuestLimitsText(limits: {
	hiddenFiles: number;
	appsNeedingSignIn: number;
}): string | null {
	const parts = [
		limits.hiddenFiles > 0
			? `${limits.hiddenFiles === 1 ? "1 file holds" : `${limits.hiddenFiles} files hold`} data from connected accounts, so it stays hidden`
			: null,
		limits.appsNeedingSignIn > 0
			? `${limits.appsNeedingSignIn === 1 ? "1 app needs" : `${limits.appsNeedingSignIn} apps need`} a sign-in, so people see its name but can't open it`
			: null,
	].filter(Boolean);
	if (parts.length === 0) return null;
	return `People without a Tedix account see this workspace's documents, sheets, slides and apps, read-only. Not everything: ${parts.join("; ")}.`;
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
	const { state, copy } = useLinkCopy();
	const copied = state === "copied";
	return (
		<div className="grid min-w-0 gap-1" data-share-permanent-url>
			<div className="flex min-w-0 items-center gap-2">
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
					onClick={() => void copy(props.url)}
				>
					<Copy size={14} /> {copied ? "Copied" : "Copy link"}
				</Button>
			</div>
			<LinkCopyStatus state={state} />
		</div>
	);
}

/** Who may open an "Only people you invite" link. */
function InviteList(props: {
	shareId: string;
	noun: string;
	organization: string;
}) {
	const queryClient = useQueryClient();
	const inviteesQuery = shareInviteesQueryOptions(props.shareId);
	const invitees = useQuery(inviteesQuery);
	const [email, setEmail] = useState("");
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: inviteesQuery.queryKey });
	const undo = useUndoOffer(() => void refresh());
	/** The person about to be removed, with what the server says it does. */
	const [removal, setRemoval] = useState<InviteeRemoval | null>(null);
	const previewRemoval = useMutation({
		mutationFn: async (
			invitee: Omit<InviteeRemoval, "impact">,
		): Promise<InviteeRemoval> => ({
			...invitee,
			impact: await osApi.osShares.shares.previewChange({
				shareId: props.shareId,
				change: { kind: "removeInvitee", inviteeId: invitee.inviteeId },
			}),
		}),
		onSuccess: setRemoval,
	});
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
		mutationFn: (target: InviteeRemoval) =>
			osApi.osShares.shares.invitees.remove({
				shareId: props.shareId,
				inviteeId: target.inviteeId,
			}),
		onSuccess: (_result, target) => {
			setRemoval(null);
			const removedEmail = target.email;
			// Adding the same address back restores exactly what was removed.
			undo.show(
				removedEmail
					? {
							text: `Removed ${target.label}.`,
							run: () =>
								osApi.osShares.shares.invitees.add({
									shareId: props.shareId,
									email: removedEmail,
								}),
						}
					: null,
			);
		},
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
			<Text as="p" tone="secondary" className="m-0">
				Invitees need no account. They enter a code sent to their email.
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
									disabled={remove.isPending || previewRemoval.isPending}
									onClick={() =>
										previewRemoval.mutate({
											inviteeId: invitee.id,
											email: invitee.email,
											label,
										})
									}
								>
									Remove
								</Button>
							</li>
						);
					})}
				</ul>
			) : null}
			{invitees.data?.opens?.length ? (
				<div className="grid gap-1" aria-label="Link opens">
					<Text as="h3" role="label">
						Opened by
					</Text>
					{invitees.data.opens.map((open, index) => (
						<Text
							as="p"
							key={`${open.email}-${open.openedAt}-${index}`}
							className="m-0"
						>
							{open.email} ·{" "}
							<time dateTime={open.openedAt}>
								{new Date(open.openedAt).toLocaleString()}
							</time>
						</Text>
					))}
				</div>
			) : null}
			{removal ? (
				<Alert variant="warning" data-share-remove-invitee>
					<Prohibit aria-hidden />
					<AlertTitle>Remove {removal.label}?</AlertTitle>
					<AlertDescription className="space-y-3">
						<ImpactSentences
							impact={removal.impact}
							noun={props.noun}
							organization={props.organization}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="destructive"
								loading={remove.isPending}
								onClick={() => remove.mutate(removal)}
							>
								Remove
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setRemoval(null)}
							>
								Keep
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			<UndoNotice undo={undo} />
			{remove.isError || previewRemoval.isError ? (
				<Text role="label" tone="error" className="m-0" aria-live="polite">
					{shareErrorText(
						remove.error ?? previewRemoval.error,
						"Couldn't remove that person.",
					)}
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
	/** A change to the main link, waiting for the person to confirm it. */
	const [pending, setPending] = useState<PendingLinkChange | null>(null);
	const queryClient = useQueryClient();
	const sharesQuery = osSharesQueryOptions({ resourceType, resourceId });
	const shares = useQuery(sharesQuery);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey });
	const undo = useUndoOffer(() => void invalidate());
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
		mutationFn: (input: {
			shareId: string;
			access: OsShareAccess;
			/** Only invited people can edit, so another audience goes back to use. */
			endsEditing: boolean;
			/** What to offer Undo for, when the change took access away. */
			undo?: { previous: OsShareAccess; text: string };
		}) =>
			osApi.osShares.shares.update({
				shareId: input.shareId,
				access: input.access,
				...(input.endsEditing ? { role: "use" as const } : {}),
			}),
		onSuccess: (_result, input) => {
			setPending(null);
			const offer = input.undo;
			// Invited people stay on the link's list, so going back to the
			// earlier choice restores exactly who could open it.
			undo.show(
				offer
					? {
							text: offer.text,
							run: () =>
								osApi.osShares.shares.update({
									shareId: input.shareId,
									access: offer.previous,
									...(input.endsEditing ? { role: "edit" as const } : {}),
								}),
						}
					: null,
			);
		},
		onSettled: () => void invalidate(),
	});
	// Every change to who can open the link is put to the server first, so
	// the dialog can say who loses or gains access before anything changes.
	const previewChange = useMutation({
		mutationFn: async (
			change: LinkChangeRequest,
		): Promise<PendingLinkChange> => ({
			...change,
			impact: await osApi.osShares.shares.previewChange({
				shareId: change.shareId,
				change:
					change.kind === "access"
						? { kind: "access", access: change.access }
						: { kind: "off" },
			}),
		}),
		onSuccess: setPending,
	});
	// While a change is on its way, the choice already shows as made.
	const access: OsShareAccess =
		(link
			? ((changeAccess.isPending ? changeAccess.variables?.access : null) ??
				(pending?.kind === "access" ? pending.access : null) ??
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
	// What invited people may do. The server decides on every save whether a
	// person may edit; this only records the owner's choice on the link.
	const changeRole = useMutation({
		mutationFn: (input: { shareId: string; role: "use" | "edit" }) =>
			osApi.osShares.shares.update(input),
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
		mutationFn: (input: {
			shareId: string;
			disabled: boolean;
			/** Said beside Undo after the link was turned off. */
			undoText?: string;
		}) =>
			osApi.osShares.shares.setDisabled({
				shareId: input.shareId,
				disabled: input.disabled,
			}),
		onSuccess: (_result, input) => {
			setConfirmOff(null);
			setPending(null);
			setStaged(null);
			// The link keeps its address and invite list while off, so turning
			// it back on restores exactly who could open it.
			undo.show(
				input.disabled && input.undoText
					? {
							text: input.undoText,
							run: () =>
								osApi.osShares.shares.setDisabled({
									shareId: input.shareId,
									disabled: false,
								}),
						}
					: null,
			);
		},
		onSettled: () => void invalidate(),
	});
	// "Delete link" is the permanent one: it removes the row for good, so a
	// new link mints a new id — unlike turning the link off.
	const deleteLink = useMutation({
		mutationFn: (shareId: string) => osApi.osShares.shares.delete({ shareId }),
		onSuccess: () => {
			setConfirmOff(null);
			setPending(null);
			setStaged(null);
			undo.show(null);
		},
		onSettled: () => void invalidate(),
	});
	const busy =
		createLink.isPending ||
		changeAccess.isPending ||
		previewChange.isPending ||
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
		changeRole.error ??
		updateSettings.error ??
		setDisabled.error ??
		deleteLink.error ??
		previewChange.error ??
		previewRevoke.error;
	const chooseAccess = (option: OsShareAccess) => {
		if (!link) setStaged(option);
		else if (option !== link.access)
			previewChange.mutate({
				kind: "access",
				shareId: link.id,
				access: option,
				previous: link.access,
			});
		else setPending(null);
	};
	const impactOptions = { noun, organization };
	const confirmPending = (change: PendingLinkChange) => {
		const narrows = impactNarrows(change.impact);
		const doneText = shareImpactSentences(change.impact, {
			...impactOptions,
			done: true,
		}).join(" ");
		if (change.kind === "access")
			changeAccess.mutate({
				shareId: change.shareId,
				access: change.access,
				endsEditing: link?.role === "edit" && change.access !== "invited",
				...(narrows
					? { undo: { previous: change.previous, text: doneText } }
					: {}),
			});
		else if (change.kind === "off")
			setDisabled.mutate({
				shareId: change.shareId,
				disabled: true,
				undoText: `Link turned off. ${doneText}`.trim(),
			});
		else deleteLink.mutate(change.shareId);
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
				{access === "anyone_with_link" &&
				shares.data?.guestLimits &&
				workspaceGuestLimitsText(shares.data.guestLimits) ? (
					<Surface
						className="m-0 px-3 py-2 text-kumo-subtle text-xs"
						render={<p />}
						data-guest-limits
					>
						{workspaceGuestLimitsText(shares.data.guestLimits)}
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
										onClick={() =>
											previewChange.mutate({ kind: "off", shareId: link.id })
										}
									>
										<Prohibit size={14} /> Turn off link
									</DropdownMenuItem>
								)}
								{canEditSettings ? (
									<DropdownMenuItem
										variant="destructive"
										onClick={() =>
											previewChange.mutate({
												kind: "delete",
												shareId: link.id,
											})
										}
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
								{link.stoppedByPrivateWorkspace
									? `This link stopped working when the workspace became private. Turn it back on to share this ${noun} on its own; the address stays the same.`
									: "The link is off. The address is kept — turning it back on revives the same one."}
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
			{link && pending?.shareId === link.id ? (
				<Alert variant="warning" data-share-pending={pending.kind}>
					<Prohibit aria-hidden />
					<AlertTitle>
						{pending.kind === "access"
							? `Change to “${accessLabel(pending.access, organization)}”?`
							: pending.kind === "off"
								? "Turn off this link?"
								: "Delete this link?"}
					</AlertTitle>
					<AlertDescription className="space-y-3">
						<ImpactSentences impact={pending.impact} {...impactOptions} />
						{pending.kind === "access" &&
						link.role === "edit" &&
						pending.access !== "invited" ? (
							<p className="m-0" data-share-ends-editing>
								Nobody will be able to edit through this link any more: only
								people you invite by email can edit.
							</p>
						) : null}
						<p className="m-0">
							{pending.kind === "delete"
								? "The address stops working for good and this can't be undone. A new link would get a new address."
								: pending.kind === "off"
									? "The link keeps its address, so you can turn it back on any time."
									: impactNarrows(pending.impact)
										? "You can undo this right after."
										: "The address stays the same."}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant={
									pending.kind === "access" && !impactNarrows(pending.impact)
										? "default"
										: "destructive"
								}
								loading={
									changeAccess.isPending ||
									setDisabled.isPending ||
									deleteLink.isPending
								}
								onClick={() => confirmPending(pending)}
								data-share-pending-confirm
							>
								{pending.kind === "access"
									? "Change access"
									: pending.kind === "off"
										? "Turn off link"
										: "Delete link"}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setPending(null)}
							>
								{pending.kind === "access" ? "Keep as it is" : "Keep link"}
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			<UndoNotice undo={undo} />
			{link?.access === "invited" ? (
				<InviteList shareId={link.id} noun={noun} organization={organization} />
			) : null}
			{link?.access === "invited" &&
			resourceType === "gadget" &&
			(link.role === "use" || link.role === "edit") ? (
				<InvitedRole
					role={link.role}
					noun={noun}
					pending={changeRole.isPending}
					onChange={(role) => changeRole.mutate({ shareId: link.id, role })}
				/>
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
	const [open, setOpen] = useState(false);
	const { compact, label, ...panelProps } = props;
	return (
		<>
			<ShareButton
				compact={compact}
				label={label}
				expanded={open}
				onClick={() => setOpen(true)}
			/>
			<ShareDialog
				{...(panelProps as ShareLinksPanelProps)}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
}

/**
 * The Share dialog on its own, for a page that opens it from somewhere
 * other than a Share button, such as a card's ⋯ menu.
 */
export function ShareDialog(
	props: ShareLinksPanelProps & {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	},
) {
	const { resourceType } = normalizeResource(props);
	const noun = RESOURCE_NOUN[resourceType];
	const { open, onOpenChange, onOpenReview, ...panelProps } = props;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
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
										onOpenChange(false);
										onOpenReview();
									}
								: undefined
						}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** On phones, Share is a near full-height sheet so its sections fit. */
export const SHARE_DIALOG_CLASS =
	"max-sm:max-h-[calc(var(--viewport-tedix-height)-0.5rem)]";
