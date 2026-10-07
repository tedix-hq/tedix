import { ReviewFeedbackSummary } from "./review-feedback-summary";
import { CreateReviewBatch } from "./create-review-batch";
import { Copy, LinkSimple, Prohibit } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsShareLink,
	OsShareResourceType,
	OsShareRevisionMode,
	OsShareRole,
} from "@tedix/api-contract/contracts/os-shares";
import { resolveOsTenant } from "@/shared/os-tenant";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { DateTimePicker } from "@/components/kumo/date-picker";
import { Input } from "@/components/kumo/input";
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
import { osSharesQueryOptions } from "@/lib/os-query-options";
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

export function ShareRow(props: {
	share: OsShareLink;
	onRevoke?: (shareId: string) => void;
	revoking?: boolean;
}) {
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
			<Badge variant="secondary">{props.share.role}</Badge>
			<Badge variant="secondary">{props.share.revisionMode}</Badge>
			<Badge variant={shareStatusVariant(status)}>{status}</Badge>
			{props.share.policyMaxRole && (
				<Text as="span" role="label" tone="warning" className="w-full pl-6">
					Policy-limited to {props.share.policyMaxRole}:{" "}
					{props.share.policyReason}
				</Text>
			)}
			{status !== "revoked" && props.onRevoke && (
				<Button
					variant="ghost"
					size="sm"
					disabled={props.revoking}
					onClick={() => props.onRevoke?.(props.share.id)}
					aria-label="Preview and revoke share link"
				>
					<Prohibit size={14} /> Revoke
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
				Anyone holding this link receives {props.role} access to this{" "}
				{props.resourceType}. The secret is shown only once; Tedix stores only
				its hash and never transfers your connections or credentials.
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

type ShareControlsProps = (
	| { outputId: string; currentRevisionId?: string | null }
	| {
			resourceType: "gadget" | "workspace";
			resourceId: string;
			currentRevisionId?: string | null;
	  }
) & { compact?: boolean };

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
				className="grid max-h-[min(var(--available-height),calc(var(--viewport-tedix-height)-2rem))] w-[min(30rem,calc(100vw-2rem))] gap-3 overflow-y-auto p-3"
			>
				<PopoverTitle className="m-0 text-kumo-subtle uppercase tracking-wide type-tedix-caption font-semibold">
					Governed share links
				</PopoverTitle>
				{localEvaluation && (
					<Surface
						className="m-0 px-3 py-2 text-kumo-subtle text-xs"
						render={<p />}
					>
						Local share links stay inside this isolated dataset. They do not
						invite a production tenant member or transfer production authority.
					</Surface>
				)}
				{createShare.data && (
					<OneTimeLink
						token={createShare.data.token}
						base={shareBase}
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
						Share links are unavailable: {(shares.error as Error).message}
					</Text>
				)}
				{shares.data &&
					(shares.data.items.length === 0 ? (
						<Text role="label" tone="secondary" className="m-0">
							No share links yet. Choose the least authority and whether it
							follows living revisions.
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
						<AlertTitle>Revoke shared link?</AlertTitle>
						<AlertDescription className="space-y-3">
							<p>
								Revoking will immediately end {revokeImpact.activeSessionCount}{" "}
								active{" "}
								{revokeImpact.activeSessionCount === 1 ? "session" : "sessions"}
								.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="destructive"
									onClick={() => revokeShare.mutate(revokeImpact.shareId)}
								>
									Confirm revoke
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
				{resourceType !== "output" && (
					<Text as="label" role="label" tone="secondary" className="grid gap-1">
						Access role
						<SegmentedControl
							ariaLabel="Share access role"
							value={role as "use" | "build"}
							onValueChange={setRole}
							options={[
								{ value: "use", label: "Use Gadget" },
								{ value: "build", label: "Build workspace" },
							]}
						/>
						<span>
							Use hides source and chat. Build still requires the recipient's
							own Tedix authoring authority.
						</span>
					</Text>
				)}
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					Revision behavior
					<SegmentedControl
						ariaLabel="Share revision behavior"
						value={revisionMode}
						onValueChange={setRevisionMode}
						options={
							cannotPinRevision
								? [{ value: "living", label: "Living" }]
								: [
										{ value: "living", label: "Living" },
										{ value: "pinned", label: "Pinned" },
									]
						}
					/>
					<span>
						{cannotPinRevision
							? `Commit this ${resourceType} before pinning.`
							: "Pinned freezes the current revision; living follows future commits."}
					</span>
				</Text>
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					Share note
					<Input
						value={note}
						onChange={(event) => setNote(event.target.value)}
						aria-label="Share note"
						maxLength={240}
						placeholder="Why this access is being granted"
					/>
				</Text>
				{/* A composite control has no single labellable input, so this is a
					    described group rather than an implicit <label>. */}
				<div className="grid gap-1 text-kumo-subtle text-xs">
					<span>Link expiry</span>
					<DateTimePicker
						aria-label="Link expiry"
						value={expiresAt}
						onChange={setExpiresAt}
						min={new Date()}
						placeholder="No expiry"
					/>
					<span>
						Optional. Leave blank for a link that expires only when revoked.
					</span>
				</div>
				{(createShare.isPending || revokeShare.isPending) && (
					<p
						className="m-0 text-kumo-subtle text-xs"
						role="status"
						data-slot="share-pending"
					>
						{createShare.isPending
							? "Waiting for the server to mint the link…"
							: "Waiting for the server to confirm the revoke…"}
					</p>
				)}
				{(createShare.isError ||
					revokeShare.isError ||
					previewRevoke.isError) && (
					<p className="m-0 text-kumo-danger text-xs" role="alert">
						{createShare.isError
							? `Create failed: ${(createShare.error as Error).message}`
							: revokeShare.isError
								? `Revoke failed: ${(revokeShare.error as Error).message}`
								: `Preview failed: ${(previewRevoke.error as Error).message}`}
					</p>
				)}
				<Button
					variant="secondary"
					size="sm"
					loading={createShare.isPending}
					disabled={
						createShare.isPending ||
						(revisionMode === "pinned" && cannotPinRevision)
					}
					onClick={() => createShare.mutate()}
				>
					<LinkSimple size={14} />{" "}
					{createShare.isPending ? "Creating…" : "Create share link"}
				</Button>
			</PopoverContent>
		</PopoverRoot>
	);
}
