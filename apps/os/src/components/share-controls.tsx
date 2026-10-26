import { ReviewFeedbackSummary } from "./review-feedback-summary";
import { CreateReviewBatch } from "./create-review-batch";
import {
	Copy,
	LinkSimple,
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

export function ShareRow(props: {
	share: OsShareLink;
	onRevoke?: (shareId: string) => void;
	revoking?: boolean;
}) {
	useOsFormattingPreferences();
	const status = shareStatus(props.share);
	return (
		<li className="flex flex-wrap items-center gap-2 py-1.5">
			<LinkSimple size={14} className="shrink-0 text-kumo-subtle" />
			<Text
				as="span"
				role="label"
				tone="secondary"
				className="min-w-32 flex-1 truncate"
				title={absoluteTime(props.share.createdAt)}
			>
				Created {relativeTime(props.share.createdAt)} ·{" "}
				{shareExpiryLabel(props.share)}
			</Text>
			<Badge variant="secondary">{ROLE_LABEL[props.share.role]}</Badge>
			<Badge variant="secondary">
				{revisionModeLabel(props.share.revisionMode)}
			</Badge>
			<Badge variant={shareStatusVariant(status)}>{STATUS_LABEL[status]}</Badge>
			{props.share.policyMaxRole && (
				<Text as="span" role="label" tone="warning" className="w-full pl-6">
					Your organization limits this link to{" "}
					{ROLE_LABEL[props.share.policyMaxRole].toLowerCase()}:{" "}
					{props.share.policyReason}
				</Text>
			)}
			{status !== "revoked" && props.onRevoke && (
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
			{props.share.resourceType === "gadget" && props.share.role === "use" && (
				<ReviewFeedbackSummary shareId={props.share.id} />
			)}
			{props.share.resourceType === "gadget" &&
				props.share.role === "use" &&
				status === "active" && (
					// A new round reuses this link: recipients keep one bookmark.
					<div className="w-full pl-6">
						<CreateReviewBatch
							shareId={props.share.id}
							gadgetId={props.share.resourceId}
							label="Add a new review round"
						/>
					</div>
				)}
		</li>
	);
}

function OneTimeLink(props: {
	token: string;
	base: string;
	role: OsShareRole;
	resourceType: OsShareResourceType;
	onDismiss: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const url = formatShareLink(props.token, props.base);
	return (
		<Surface className="grid gap-2 p-3">
			<Text
				as="code"
				role="label"
				tone="strong"
				className="break-all"
				aria-label="Share link URL"
			>
				{url}
			</Text>
			<Text role="label" tone="secondary" className="m-0">
				Anyone with this link can {ROLE_VERB[props.role]} this{" "}
				{RESOURCE_NOUN[props.resourceType]}. Copy it now: it is shown only once.
				Your connected accounts are never shared.
			</Text>
			<div className="flex items-center gap-2">
				<Button
					size="sm"
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
						<li key={row.key} className="flex items-center gap-2 py-1.5">
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

type ShareControlsProps = (
	| { outputId: string; currentRevisionId?: string | null }
	| {
			resourceType: "gadget" | "workspace";
			resourceId: string;
			currentRevisionId?: string | null;
	  }
) & {
	compact?: boolean;
	/** The workspace holding this resource; shows who can open it without a link. */
	workspaceId?: string;
	/**
	 * The app runs its own code, so a `use` link opens for anyone on the
	 * account-free guest page instead of the signed-in share page.
	 */
	guestEntry?: boolean;
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

export function ShareControls(props: ShareControlsProps) {
	const { resourceType, resourceId, currentRevisionId } =
		normalizeResource(props);
	const [open, setOpen] = useState(false);
	const [expiresAt, setExpiresAt] = useState<Date | null>(null);
	const [note, setNote] = useState("");
	const [role, setRole] = useState<OsShareRole>(
		resourceType === "output" ? "viewer" : "use",
	);
	const [revisionMode, setRevisionMode] =
		useState<OsShareRevisionMode>("living");
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
	const createShare = useMutation({
		mutationFn: () =>
			osApi.osShares.shares.create({
				resourceType,
				resourceId,
				role,
				revisionMode,
				...(revisionMode === "pinned" &&
				resourceType !== "workspace" &&
				currentRevisionId
					? { pinnedRevisionId: currentRevisionId }
					: {}),
				...(note.trim() ? { note: note.trim() } : {}),
				...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
			}),
		onSuccess: invalidate,
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
						<Button variant="secondary" size="sm" title="Share">
							<LinkSimple size={14} /> Share
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
				{props.workspaceId ? (
					<Text
						as="h3"
						role="label"
						tone="strong"
						className="m-0 border-kumo-line border-t pt-4"
					>
						Share links
					</Text>
				) : null}
				{createShare.data && (
					<OneTimeLink
						token={createShare.data.token}
						base={
							props.guestEntry &&
							resourceType === "gadget" &&
							createShare.data.share.role === "use" &&
							typeof window !== "undefined"
								? `${window.location.origin}/guest`
								: shareBase
						}
						role={createShare.data.share.role}
						resourceType={resourceType}
						onDismiss={() => createShare.reset()}
					/>
				)}
				{createShare.data &&
					resourceType === "gadget" &&
					createShare.data.share.role === "use" && (
						<CreateReviewBatch
							shareId={createShare.data.share.id}
							gadgetId={resourceId}
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
				{shares.data &&
					(shares.data.items.length === 0 ? (
						<Text role="label" tone="secondary" className="m-0">
							No links yet.
						</Text>
					) : (
						<ul className="m-0 grid list-none gap-0.5 p-0">
							{shares.data.items.map((share) => (
								<ShareRow
									key={share.id}
									share={share}
									onRevoke={(shareId) => previewRevoke.mutate(shareId)}
									revoking={previewRevoke.isPending || revokeShare.isPending}
								/>
							))}
						</ul>
					))}
				{revokeImpact && (
					<Alert variant="warning">
						<Prohibit aria-hidden />
						<AlertTitle>Turn off this link?</AlertTitle>
						<AlertDescription className="space-y-3">
							<p>
								The link stops working right away.{" "}
								{revokeImpact.activeSessionCount === 0
									? "Nobody has it open now."
									: `${revokeImpact.activeSessionCount} ${
											revokeImpact.activeSessionCount === 1
												? "person has"
												: "people have"
										} it open now and will lose access.`}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="destructive"
									onClick={() => revokeShare.mutate(revokeImpact.shareId)}
								>
									Turn off link
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setRevokeImpact(null)}
								>
									Keep link
								</Button>
							</div>
						</AlertDescription>
					</Alert>
				)}
				<div className="grid gap-4 border-kumo-line border-t pt-4">
					{resourceType !== "output" && (
						<ShareField
							as="div"
							label="People with the link can"
							hint="Use: they can use the app but not see how it is built. Edit: they also need their own Tedix access."
						>
							<SegmentedControl
								ariaLabel="Share access role"
								fill
								value={role as "use" | "build"}
								onValueChange={setRole}
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
							cannotPinRevision
								? `Save this ${noun} first to share a fixed version.`
								: "Latest version follows your changes. This version stays as it is now."
						}
					>
						<SegmentedControl
							ariaLabel="Share revision behavior"
							fill
							value={revisionMode}
							onValueChange={setRevisionMode}
							options={
								cannotPinRevision
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
							value={note}
							onChange={(event) => setNote(event.target.value)}
							aria-label="Share note"
							maxLength={240}
							placeholder="For example: for Adriana to review"
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
							value={expiresAt}
							onChange={setExpiresAt}
							min={new Date()}
							placeholder="Never"
						/>
					</ShareField>
				</div>
				{(createShare.isPending || revokeShare.isPending) && (
					<p
						className="m-0 text-kumo-subtle text-xs"
						role="status"
						data-slot="share-pending"
					>
						{createShare.isPending ? "Creating link…" : "Turning off link…"}
					</p>
				)}
				{(createShare.isError ||
					revokeShare.isError ||
					previewRevoke.isError) && (
					<p className="m-0 text-kumo-danger text-xs" role="alert">
						{createShare.isError
							? `Couldn't create the link. ${(createShare.error as Error).message}`
							: revokeShare.isError
								? `Couldn't turn off the link. ${(revokeShare.error as Error).message}`
								: `Couldn't check this link. ${(previewRevoke.error as Error).message}`}
					</p>
				)}
				<Button
					className="w-full justify-center"
					loading={createShare.isPending}
					disabled={
						createShare.isPending ||
						(revisionMode === "pinned" && cannotPinRevision)
					}
					onClick={() => createShare.mutate()}
				>
					<LinkSimple size={14} /> Create link
				</Button>
			</PopoverContent>
		</PopoverRoot>
	);
}
