import { Globe, LinkSimple, User, UserPlus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsAffectedCollaborator,
	OsCollaboratorRole,
	OsCollaboratorTarget,
} from "@tedix/api-contract/schemas/os-collaborators";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import {
	formatShareLink,
	shareLinkBase,
	shareStatus,
} from "@/components/share-controls";
import { osApi } from "@/lib/api";
import {
	osQueryKeys,
	osSharesQueryOptions,
	workspaceCollaboratorsQueryOptions,
} from "@/lib/os-query-options";

export const ROLE_LABEL: Record<OsCollaboratorRole, string> = {
	use: "Can use",
	build: "Can build",
};

const ROLE_OPTIONS = [
	{ value: "use" as const, label: "Can use" },
	{ value: "build" as const, label: "Can build" },
];

export function workspaceShareUrl(
	origin: string,
	workspaceId: string,
	key: string,
): string {
	return `${origin}/shared/workspace/${encodeURIComponent(workspaceId)}#share=${encodeURIComponent(key)}`;
}

function personLabel(person: { name: string | null; email: string | null }) {
	return person.name ?? person.email ?? "Someone";
}

/** One sentence per consequence, so the confirm says exactly who changes. */
export function removalConsequences(
	affected: readonly OsAffectedCollaborator[],
	target: OsCollaboratorTarget,
): { removed: OsAffectedCollaborator[]; downgraded: OsAffectedCollaborator[] } {
	const others = affected.filter(
		(person) => target.kind !== "user" || person.userId !== target.userId,
	);
	return {
		removed: others.filter((person) => person.newRole === null),
		downgraded: others.filter((person) => person.newRole !== null),
	};
}

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

type PendingRemoval = {
	target: OsCollaboratorTarget;
	label: string;
	affected: OsAffectedCollaborator[];
	keep: Set<string>;
};

export function WorkspaceShareDialog(props: {
	workspaceId: string;
	workspaceName: string;
	/** Private workspaces cannot have a no-sign-in link. */
	visibility?: "org" | "private";
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { workspaceId } = props;
	const queryClient = useQueryClient();
	const sharing = useQuery({
		...workspaceCollaboratorsQueryOptions(workspaceId),
		enabled: props.open,
	});
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<OsCollaboratorRole>("use");
	const [linkRole, setLinkRole] = useState<OsCollaboratorRole>("use");
	const [linkLabel, setLinkLabel] = useState("");
	const [freshUrl, setFreshUrl] = useState<string | null>(null);
	const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingRemoval | null>(null);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: osQueryKeys.collaborators() });
	const origin = typeof window === "undefined" ? "" : window.location.origin;

	const invite = useMutation({
		mutationFn: () =>
			osApi.osCollaborators.add({
				workspaceId,
				email: email.trim(),
				role: inviteRole,
			}),
		onSuccess: () => {
			setEmail("");
			void refresh();
		},
	});
	const createLink = useMutation({
		mutationFn: () =>
			osApi.osCollaborators.createLink({
				workspaceId,
				role: linkRole,
				...(linkLabel.trim() ? { label: linkLabel.trim() } : {}),
			}),
		onSuccess: (result) => {
			setFreshUrl(workspaceShareUrl(origin, workspaceId, result.key));
			setLinkLabel("");
			void refresh();
		},
	});
	const copyLink = useMutation({
		mutationFn: async (linkId: string) => {
			const { key } = await osApi.osCollaborators.copyLink({
				workspaceId,
				linkId,
			});
			await navigator.clipboard.writeText(
				workspaceShareUrl(origin, workspaceId, key),
			);
			return linkId;
		},
		onSuccess: (linkId) => setCopiedLinkId(linkId),
	});
	const preview = useMutation({
		mutationFn: async (input: {
			target: OsCollaboratorTarget;
			label: string;
		}) => {
			const { affected } = await osApi.osCollaborators.previewRemove({
				workspaceId,
				target: input.target,
			});
			return { ...input, affected };
		},
		onSuccess: (result) => setPending({ ...result, keep: new Set() }),
	});
	const remove = useMutation({
		mutationFn: (removal: PendingRemoval) =>
			osApi.osCollaborators.remove({
				workspaceId,
				target: removal.target,
				keepUserIds: [...removal.keep],
			}),
		onSuccess: () => {
			setPending(null);
			void refresh();
		},
	});

	const submitInvite = (event: FormEvent) => {
		event.preventDefault();
		if (email.trim()) invite.mutate();
	};
	const data = sharing.data;
	const canGrantBuild = data?.role === "build";

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Share {props.workspaceName}</DialogTitle>
					<DialogDescription>
						People sign in with their own Tedix account. They use their own AI
						model and their own connected accounts, never yours.
					</DialogDescription>
				</DialogHeader>

				{sharing.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Can't load sharing</AlertTitle>
						<AlertDescription>
							{errorText(sharing.error, "Try again in a moment.")}
						</AlertDescription>
					</Alert>
				) : null}

				<form className="grid gap-2" onSubmit={submitInvite}>
					<Text as="h3" role="label" tone="strong" className="m-0">
						Invite people
					</Text>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							aria-label="Email address"
							type="email"
							autoComplete="off"
							placeholder="name@company.com"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							className="min-w-0 flex-1"
						/>
						<SegmentedControl
							ariaLabel="Role for the invited person"
							value={inviteRole}
							onValueChange={setInviteRole}
							options={canGrantBuild ? ROLE_OPTIONS : ROLE_OPTIONS.slice(0, 1)}
						/>
						<Button
							type="submit"
							className="max-sm:w-full max-sm:justify-center"
							loading={invite.isPending}
							disabled={!email.trim() || invite.isPending}
						>
							<UserPlus size={14} /> Invite
						</Button>
					</div>
					{invite.isError ? (
						<Text role="label" tone="error" className="m-0" aria-live="polite">
							{errorText(invite.error, "Couldn't add that person.")}
						</Text>
					) : (
						<Text role="label" tone="secondary" className="m-0">
							They need a Tedix account. Tedix doesn't email them; send them the
							workspace link.
						</Text>
					)}
				</form>

				<section className="grid gap-1" aria-label="People with access">
					<Text as="h3" role="label" tone="strong" className="m-0">
						People with access
					</Text>
					<ul className="m-0 grid list-none p-0">
						<li className="flex min-h-11 items-center gap-3">
							<User size={16} className="shrink-0 text-kumo-subtle" />
							<span className="min-w-0 flex-1 truncate">
								{data?.ownerName ?? "Owner"}
							</span>
							<Badge variant="secondary">Owner</Badge>
						</li>
						{data?.collaborators.map((person) => (
							<li
								key={person.userId}
								className="flex min-h-11 items-center gap-3"
								data-collaborator={person.userId}
							>
								<User size={16} className="shrink-0 text-kumo-subtle" />
								<span className="grid min-w-0 flex-1">
									<span className="truncate">{personLabel(person)}</span>
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="truncate"
									>
										{person.name && person.email ? `${person.email} · ` : ""}
										{person.addedBy.length
											? `Added by ${person.addedBy.join(", ")}`
											: ""}
									</Text>
								</span>
								<Badge variant="secondary">{ROLE_LABEL[person.role]}</Badge>
								{person.canRemove ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Remove ${personLabel(person)}`}
										disabled={preview.isPending || remove.isPending}
										onClick={() =>
											preview.mutate({
												target: { kind: "user", userId: person.userId },
												label: personLabel(person),
											})
										}
									>
										Remove
									</Button>
								) : null}
							</li>
						))}
					</ul>
					{data && data.collaborators.length === 0 ? (
						<Text role="label" tone="secondary" className="m-0">
							Only the owner has access so far.
						</Text>
					) : null}
				</section>

				{pending ? (
					<RemovalConfirm
						pending={pending}
						busy={remove.isPending}
						error={remove.isError ? errorText(remove.error, "") : null}
						onToggleKeep={(userId) =>
							setPending((current) => {
								if (!current) return current;
								const keep = new Set(current.keep);
								if (keep.has(userId)) keep.delete(userId);
								else keep.add(userId);
								return { ...current, keep };
							})
						}
						onCancel={() => setPending(null)}
						onConfirm={() => remove.mutate(pending)}
					/>
				) : null}
				{preview.isError ? (
					<Text role="label" tone="error" className="m-0">
						{errorText(preview.error, "Couldn't check who would be affected.")}
					</Text>
				) : null}

				<section
					className="grid gap-2 border-kumo-line border-t pt-4"
					aria-label="Share links"
				>
					<Text as="h3" role="label" tone="strong" className="m-0">
						Share links
					</Text>
					<Text role="label" tone="secondary" className="m-0">
						Anyone who opens a link and signs in to Tedix joins at the link's
						role.
					</Text>
					{freshUrl ? (
						<div className="grid gap-1" data-fresh-link>
							<ClipboardText text={freshUrl} className="max-w-full" />
							<Text role="label" tone="secondary" className="m-0">
								Copy it now. Tedix keeps only a fingerprint, so this exact link
								can't be shown again.
							</Text>
						</div>
					) : null}
					<ul className="m-0 grid list-none p-0">
						{data?.links.map((link) => (
							<li
								key={link.id}
								className="flex min-h-11 items-center gap-3"
								data-share-link={link.id}
							>
								<LinkSimple size={16} className="shrink-0 text-kumo-subtle" />
								<span className="grid min-w-0 flex-1">
									<span className="truncate">{link.label ?? "Share link"}</span>
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="truncate"
									>
										Made by {personLabel(link.createdBy)}
									</Text>
								</span>
								<Badge variant="secondary">{ROLE_LABEL[link.role]}</Badge>
								<Button
									size="sm"
									variant="ghost"
									disabled={copyLink.isPending}
									onClick={() => copyLink.mutate(link.id)}
								>
									{copiedLinkId === link.id ? "Copied" : "Copy"}
								</Button>
								{link.canRevoke ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Revoke ${link.label ?? "share link"}`}
										disabled={preview.isPending || remove.isPending}
										onClick={() =>
											preview.mutate({
												target: { kind: "link", linkId: link.id },
												label: link.label ?? "this link",
											})
										}
									>
										Revoke
									</Button>
								) : null}
							</li>
						))}
					</ul>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							aria-label="Link name"
							placeholder="Link name (optional)"
							maxLength={120}
							value={linkLabel}
							onChange={(event) => setLinkLabel(event.target.value)}
							className="min-w-0 flex-1"
						/>
						<SegmentedControl
							ariaLabel="Role for people who open the link"
							value={linkRole}
							onValueChange={setLinkRole}
							options={canGrantBuild ? ROLE_OPTIONS : ROLE_OPTIONS.slice(0, 1)}
						/>
						<Button
							variant="secondary"
							className="max-sm:w-full max-sm:justify-center"
							loading={createLink.isPending}
							disabled={createLink.isPending || !data}
							onClick={() => createLink.mutate()}
						>
							<LinkSimple size={14} /> Create link
						</Button>
					</div>
					{createLink.isError || copyLink.isError ? (
						<Text role="label" tone="error" className="m-0">
							{errorText(
								createLink.error ?? copyLink.error,
								"Couldn't make the link.",
							)}
						</Text>
					) : null}
				</section>
				<PublicLinkSection
					workspaceId={workspaceId}
					isPrivate={props.visibility === "private"}
					canManage={data?.role === "build"}
				/>
			</DialogContent>
		</Dialog>
	);
}

function RemovalConfirm(props: {
	pending: PendingRemoval;
	busy: boolean;
	error: string | null;
	onToggleKeep: (userId: string) => void;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { pending } = props;
	const { removed, downgraded } = removalConsequences(
		pending.affected,
		pending.target,
	);
	const isLink = pending.target.kind === "link";
	return (
		<Alert variant="warning" data-removal-confirm>
			<AlertTitle>
				{isLink ? `Revoke ${pending.label}?` : `Remove ${pending.label}?`}
			</AlertTitle>
			<AlertDescription className="grid gap-3">
				<p className="m-0">
					{isLink
						? "The link stops working. People who joined only through it lose access."
						: "They lose the access you gave them."}
				</p>
				{removed.length > 0 ? (
					<p className="m-0">
						This also removes{" "}
						{removed.map((person) => personLabel(person)).join(", ")}.
					</p>
				) : null}
				{downgraded.length > 0 ? (
					<p className="m-0">
						{downgraded
							.map(
								(person) =>
									`${personLabel(person)} drops to ${ROLE_LABEL[person.newRole ?? "use"].toLowerCase()}`,
							)
							.join("; ")}
						.
					</p>
				) : null}
				{removed.length + downgraded.length > 0 ? (
					<div className="grid gap-1">
						{[...removed, ...downgraded].map((person) => (
							<Checkbox
								key={person.userId}
								checked={pending.keep.has(person.userId)}
								onCheckedChange={() => props.onToggleKeep(person.userId)}
								label={`Keep ${personLabel(person)} at ${ROLE_LABEL[person.oldRole].toLowerCase()}`}
							/>
						))}
					</div>
				) : null}
				{props.error ? (
					<Text role="label" tone="error" className="m-0">
						{props.error}
					</Text>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="destructive"
						loading={props.busy}
						onClick={props.onConfirm}
					>
						{isLink ? "Revoke link" : "Remove"}
					</Button>
					<Button size="sm" variant="ghost" onClick={props.onCancel}>
						Cancel
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	);
}

/**
 * The no-sign-in link, kept apart from collaborator links: anyone holding it
 * can view the workspace's apps without a Tedix account. Off until turned on;
 * turning it off revokes every active public link.
 */
function PublicLinkSection(props: {
	workspaceId: string;
	isPrivate: boolean;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const sharesQuery = osSharesQueryOptions({
		resourceType: "workspace",
		resourceId: props.workspaceId,
	});
	const shares = useQuery(sharesQuery);
	const [token, setToken] = useState<string | null>(null);
	const active = (shares.data?.items ?? []).filter(
		(share) => shareStatus(share) === "active",
	);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey });
	const toggle = useMutation({
		mutationFn: async (on: boolean) => {
			if (on) {
				const created = await osApi.osShares.shares.create({
					resourceType: "workspace",
					resourceId: props.workspaceId,
					role: "use",
					revisionMode: "living",
				});
				return created.token;
			}
			for (const share of active)
				await osApi.osShares.shares.revoke({ shareId: share.id });
			return null;
		},
		onSuccess: (next) => {
			setToken(next);
			void refresh();
		},
	});
	const enabled = active.length > 0;
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const url = token
		? formatShareLink(
				token,
				shareLinkBase({
					resourceType: "workspace",
					origin,
					localEvaluation: false,
				}),
			)
		: null;
	return (
		<section
			className="grid gap-2 border-kumo-line border-t pt-4"
			aria-label="Public link"
			data-public-link
		>
			<div className="flex min-h-11 items-center gap-3">
				<Globe size={16} className="shrink-0 text-kumo-subtle" />
				<span className="grid min-w-0 flex-1">
					<Text as="span" role="body">
						Anyone with the link can view
					</Text>
					<Text as="span" role="label" tone="secondary">
						No sign-in. They see the apps, never how they are built.
					</Text>
				</span>
				<Switch
					aria-label="Anyone with the link can view"
					checked={enabled}
					disabled={
						props.isPrivate ||
						!props.canManage ||
						shares.isPending ||
						toggle.isPending
					}
					onCheckedChange={(checked) => toggle.mutate(checked)}
				/>
			</div>
			{props.isPrivate ? (
				<Text role="label" tone="secondary" className="m-0">
					Private workspaces can't have a public link. Invite people instead.
				</Text>
			) : null}
			{url ? (
				<div className="grid gap-1" data-public-url>
					<ClipboardText text={url} className="max-w-full" />
					<Text role="label" tone="secondary" className="m-0">
						Copy it now; it can't be shown again. Turning this off stops it.
					</Text>
				</div>
			) : enabled ? (
				<Text role="label" tone="secondary" className="m-0">
					A public link is on. Turn it off and on again for a new link.
				</Text>
			) : null}
			{toggle.isError ? (
				<Text role="label" tone="error" className="m-0">
					{errorText(toggle.error, "Couldn't change the public link.")}
				</Text>
			) : null}
		</section>
	);
}
