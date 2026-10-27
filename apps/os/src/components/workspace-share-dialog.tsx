import {
	DotsThree,
	Globe,
	Info,
	LinkSimple,
	Lock,
	PencilSimple,
	Prohibit,
	UsersThree,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsAffectedCollaborator,
	OsCollaboratorLink,
	OsCollaboratorRole,
	OsCollaboratorTarget,
} from "@tedix/api-contract/schemas/os-collaborators";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { type FormEvent, type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Avatar, AvatarFallback } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import {
	FreshLink,
	PermanentUrl,
	SHARE_DIALOG_CLASS,
	ShareLinksPanel,
	shareStatus,
} from "@/components/share-controls";
import { osApi } from "@/lib/api";
import {
	canvasGadgetDetailQueryOptions,
	osQueryKeys,
	osSharesQueryOptions,
	outputDetailQueryOptions,
	workspaceCollaboratorsQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export const ROLE_LABEL: Record<OsCollaboratorRole, string> = {
	use: "Can use",
	build: "Can build",
};

const ROLE_VERB: Record<OsCollaboratorRole, string> = {
	use: "use",
	build: "build",
};

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

function initials(label: string): string {
	const parts = label
		.replace(/@.*$/, "")
		.split(/[\s._-]+/)
		.filter(Boolean);
	const letters = parts.slice(0, 2).map((part) => part[0] ?? "");
	return letters.join("").toUpperCase() || "?";
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

/** After a role change, name anyone else whose access fell with it. */
function knockOnText(
	affected: readonly OsAffectedCollaborator[],
	changedUserId?: string,
): string | null {
	const others = affected.filter((person) => person.userId !== changedUserId);
	if (others.length === 0) return null;
	return `${others
		.map(
			(person) =>
				`${personLabel(person)} ${
					person.newRole
						? `now ${ROLE_LABEL[person.newRole].toLowerCase()}`
						: "lost access"
				}`,
		)
		.join("; ")}.`;
}

type PendingRemoval = {
	target: OsCollaboratorTarget;
	label: string;
	affected: OsAffectedCollaborator[];
	keep: Set<string>;
};

/** The app or file open in the workspace when Share is pressed. */
export type WorkspaceShareItem = {
	type: "gadget" | "output";
	id: string;
	/** Opens the app's Review tab, where review rounds are sent. */
	onOpenReview?: () => void;
};

type Scope = "workspace" | "item";

/**
 * What General access can be set to. Workspace links need a Tedix sign-in
 * and join people at a role; the public link needs no account and shows the
 * apps only.
 */
type AccessChoice = "restricted" | "link:use" | "link:build" | "public";

/** A short "Learn more" beside a heading, instead of a paragraph under it. */
function LearnMore(props: { label: string; children: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={props.label}
						className="size-6"
					/>
				}
			>
				<Info size={14} />
			</TooltipTrigger>
			<TooltipContent>{props.children}</TooltipContent>
		</Tooltip>
	);
}

function SectionHeading(props: {
	children: string;
	learnMore?: { label: string; text: string };
}) {
	return (
		<div className="flex min-h-6 items-center gap-1">
			<Text as="h3" role="label" tone="strong" className="m-0">
				{props.children}
			</Text>
			{props.learnMore ? (
				<LearnMore label={props.learnMore.label}>
					{props.learnMore.text}
				</LearnMore>
			) : null}
		</div>
	);
}

export function WorkspaceShareDialog(props: {
	workspaceId: string;
	workspaceName: string;
	/** Private workspaces cannot have a no-sign-in link. */
	visibility?: "org" | "private";
	item?: WorkspaceShareItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [scope, setScope] = useState<Scope>("workspace");
	const item = props.item;
	const gadget = useQuery({
		...canvasGadgetDetailQueryOptions(props.workspaceId, item?.id ?? ""),
		enabled: props.open && item?.type === "gadget",
	});
	const output = useQuery({
		...outputDetailQueryOptions(item?.id ?? ""),
		enabled: props.open && item?.type === "output",
	});
	const itemNoun = item?.type === "gadget" ? "app" : "file";
	const itemName =
		item?.type === "gadget"
			? gadget.data?.gadget.name
			: output.data?.output.title;
	const title =
		scope === "item" && item
			? `Share ${itemName ?? `this ${itemNoun}`}`
			: `Share ${props.workspaceName}`;

	return (
		<TooltipProvider>
			<Dialog open={props.open} onOpenChange={props.onOpenChange}>
				<DialogContent className={SHARE_DIALOG_CLASS} data-share-dialog>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					{item ? (
						<SegmentedControl
							ariaLabel="What to share"
							fill
							value={scope}
							onValueChange={setScope}
							options={[
								{ value: "workspace", label: "This workspace" },
								{ value: "item", label: `This ${itemNoun}` },
							]}
						/>
					) : null}
					{scope === "item" && item ? (
						<ItemLinks
							workspaceId={props.workspaceId}
							item={item}
							onOpenReview={
								item.onOpenReview
									? () => {
											props.onOpenChange(false);
											item.onOpenReview?.();
										}
									: undefined
							}
						/>
					) : (
						<WorkspaceAccess
							workspaceId={props.workspaceId}
							visibility={props.visibility}
						/>
					)}
				</DialogContent>
			</Dialog>
		</TooltipProvider>
	);
}

/** Links to the open app or file alone, inside the same dialog. */
function ItemLinks(props: {
	workspaceId: string;
	item: WorkspaceShareItem;
	onOpenReview?: () => void;
}) {
	const { item } = props;
	const gadget = useQuery({
		...canvasGadgetDetailQueryOptions(props.workspaceId, item.id),
		enabled: item.type === "gadget",
	});
	const output = useQuery({
		...outputDetailQueryOptions(item.id),
		enabled: item.type === "output",
	});
	return (
		<div className="grid gap-4" data-share-open-item>
			<Text role="label" tone="secondary" className="m-0">
				A link to this {item.type === "gadget" ? "app" : "file"} alone, without
				the rest of the workspace.
			</Text>
			{item.type === "gadget" && gadget.data ? (
				<ShareLinksPanel
					resourceType="gadget"
					resourceId={gadget.data.gadget.id}
					currentRevisionId={gadget.data.currentRevision?.id}
					guestEntry={isAppRuntimeManifest(
						gadget.data.currentRevision?.manifest,
					)}
					onOpenReview={props.onOpenReview}
				/>
			) : item.type === "output" && output.data ? (
				<ShareLinksPanel
					outputId={item.id}
					currentRevisionId={output.data.currentRevision.id}
				/>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					Loading…
				</Text>
			)}
		</div>
	);
}

function WorkspaceAccess(props: {
	workspaceId: string;
	visibility?: "org" | "private";
}) {
	const { workspaceId } = props;
	const queryClient = useQueryClient();
	const sharing = useQuery(workspaceCollaboratorsQueryOptions(workspaceId));
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<OsCollaboratorRole>("use");
	const [freshUrl, setFreshUrl] = useState<string | null>(null);
	const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingRemoval | null>(null);
	const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
	const [knockOn, setKnockOn] = useState<string | null>(null);
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
		mutationFn: (role: OsCollaboratorRole) =>
			osApi.osCollaborators.createLink({ workspaceId, role }),
		onSuccess: (result) => {
			setFreshUrl(workspaceShareUrl(origin, workspaceId, result.key));
			void refresh();
		},
	});
	const setRole = useMutation({
		mutationFn: (input: { userId: string; role: OsCollaboratorRole }) =>
			osApi.osCollaborators.setRole({ workspaceId, ...input }),
		onSuccess: (result, input) =>
			setKnockOn(knockOnText(result.affected, input.userId)),
		onSettled: () => void refresh(),
	});
	const updateLink = useMutation({
		mutationFn: (input: {
			linkId: string;
			label: string;
			role: OsCollaboratorRole;
		}) =>
			osApi.osCollaborators.updateLink({
				workspaceId,
				linkId: input.linkId,
				role: input.role,
				label: input.label.trim() || null,
			}),
		onSuccess: (result) => {
			setEditingLinkId(null);
			setKnockOn(knockOnText(result.affected));
		},
		onSettled: () => void refresh(),
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

	// The no-sign-in link: anyone holding it can view the workspace's apps
	// without a Tedix account. Turning it off revokes every active public link.
	const publicQuery = osSharesQueryOptions({
		resourceType: "workspace",
		resourceId: workspaceId,
	});
	const publicShares = useQuery(publicQuery);
	const activePublic = (publicShares.data?.items ?? []).filter(
		(share) => shareStatus(share) === "active",
	);
	// The no-sign-in link has a permanent address, shown whenever it is on.
	const publicUrl = activePublic[0]?.url ?? null;
	const publicToggle = useMutation({
		mutationFn: async (on: boolean) => {
			if (on) {
				await osApi.osShares.shares.create({
					resourceType: "workspace",
					resourceId: workspaceId,
					role: "use",
					access: "anyone_with_link",
					revisionMode: "living",
				});
				return;
			}
			for (const share of activePublic)
				await osApi.osShares.shares.revoke({ shareId: share.id });
		},
		onSuccess: () => {
			setFreshUrl(null);
			void queryClient.invalidateQueries({ queryKey: publicQuery.queryKey });
		},
	});

	const submitInvite = (event: FormEvent) => {
		event.preventDefault();
		if (email.trim()) invite.mutate();
	};
	const data = sharing.data;
	const canGrantBuild = data?.role === "build";
	const canManage = data?.role === "build";
	const links = data?.links ?? [];
	const newestLink = links[0] ?? null;
	const isPrivate = props.visibility === "private";
	const access: AccessChoice =
		activePublic.length > 0
			? "public"
			: newestLink
				? `link:${newestLink.role}`
				: "restricted";
	const accessLabel: Record<AccessChoice, string> = {
		restricted: "Only people invited",
		"link:use": "Anyone with the link can use",
		"link:build": "Anyone with the link can build",
		public: "Anyone with the link can view, no sign-in",
	};
	const busy =
		createLink.isPending ||
		publicToggle.isPending ||
		preview.isPending ||
		remove.isPending ||
		setRole.isPending ||
		updateLink.isPending;
	const chooseAccess = (choice: AccessChoice) => {
		if (choice === access) return;
		if (choice === "restricted") {
			if (activePublic.length > 0) publicToggle.mutate(false);
			else if (newestLink)
				preview.mutate({
					target: { kind: "link", linkId: newestLink.id },
					label: newestLink.label ?? "this link",
				});
			return;
		}
		if (choice === "public") {
			publicToggle.mutate(true);
			return;
		}
		// A sign-in link replaces the no-sign-in one; invited people keep theirs.
		if (activePublic.length > 0) publicToggle.mutate(false);
		createLink.mutate(choice === "link:build" ? "build" : "use");
	};
	const roleOptions: OsCollaboratorRole[] = canGrantBuild
		? ["use", "build"]
		: ["use"];

	return (
		<>
			{sharing.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Can't load sharing</AlertTitle>
					<AlertDescription>
						{errorText(sharing.error, "Try again in a moment.")}
					</AlertDescription>
				</Alert>
			) : null}

			<form className="grid gap-2" onSubmit={submitInvite}>
				<SectionHeading
					learnMore={{
						label: "About invites",
						text: "They sign in with their own Tedix account and use their own AI model and connected accounts, never yours. Tedix doesn't email them; send them the link.",
					}}
				>
					Add people
				</SectionHeading>
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
					<div className="flex gap-2">
						<RoleSelect
							ariaLabel="Role for the invited person"
							value={inviteRole}
							options={roleOptions}
							onChange={setInviteRole}
						/>
						<Button
							type="submit"
							className="max-sm:flex-1 max-sm:justify-center"
							loading={invite.isPending}
							disabled={!email.trim() || invite.isPending}
						>
							Invite
						</Button>
					</div>
				</div>
				{invite.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(invite.error, "Couldn't add that person.")}
					</Text>
				) : null}
			</form>

			<section className="grid gap-1" aria-label="People with access">
				<SectionHeading>People with access</SectionHeading>
				<ul className="m-0 grid list-none p-0">
					<PersonRow
						name={data?.ownerName ?? "Owner"}
						trailing={<Badge variant="secondary">Owner</Badge>}
					/>
					{props.visibility === "org" ? <EveryoneRow /> : null}
					{data?.collaborators.map((person) => (
						<PersonRow
							key={person.userId}
							name={personLabel(person)}
							detail={[
								person.name && person.email ? person.email : null,
								person.addedBy.length
									? `added by ${person.addedBy.join(", ")}`
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
							data-collaborator={person.userId}
							trailing={
								<>
									{person.canChangeRole ? (
										<RoleSelect
											ariaLabel={`Role for ${personLabel(person)}`}
											value={person.role}
											options={roleOptions}
											disabled={busy}
											onChange={(role) =>
												role !== person.role &&
												setRole.mutate({ userId: person.userId, role })
											}
										/>
									) : (
										<Text as="span" role="label" tone="secondary">
											{ROLE_LABEL[person.role]}
										</Text>
									)}
									{person.canRemove ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<Button
														size="icon-sm"
														variant="ghost"
														aria-label={`Options for ${personLabel(person)}`}
														disabled={busy}
													/>
												}
											>
												<DotsThree size={16} weight="bold" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													variant="destructive"
													onClick={() =>
														preview.mutate({
															target: { kind: "user", userId: person.userId },
															label: personLabel(person),
														})
													}
												>
													<Prohibit size={14} /> Remove {personLabel(person)}
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
								</>
							}
						/>
					))}
				</ul>
				{setRole.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(setRole.error, "Couldn't change that role.")}
					</Text>
				) : knockOn ? (
					<Text
						role="label"
						tone="secondary"
						className="m-0"
						aria-live="polite"
						data-role-knock-on
					>
						{knockOn}
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
				aria-label="General access"
				data-general-access
			>
				<SectionHeading
					learnMore={{
						label: "About links",
						text: "A link with sign-in adds people at that role once they open it. The no-sign-in link shows the apps only, never how they are built. Each link is shown once.",
					}}
				>
					General access
				</SectionHeading>
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
							disabled={busy || !data || !canManage}
						>
							<SelectValue>{accessLabel[access]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="restricted">
								{accessLabel.restricted}
							</SelectItem>
							{roleOptions.map((role) => (
								<SelectItem key={role} value={`link:${role}`}>
									Anyone with the link can {ROLE_VERB[role]}
								</SelectItem>
							))}
							{isPrivate ? null : (
								<SelectItem value="public">{accessLabel.public}</SelectItem>
							)}
						</SelectContent>
					</Select>
					{newestLink && !freshUrl && access !== "public" ? (
						<Button
							variant="secondary"
							size="sm"
							loading={copyLink.isPending}
							disabled={copyLink.isPending}
							onClick={() => copyLink.mutate(newestLink.id)}
						>
							<LinkSimple size={14} />{" "}
							{copiedLinkId === newestLink.id ? "Copied" : "Copy link"}
						</Button>
					) : null}
				</div>
				{freshUrl ? (
					<div data-fresh-link>
						<FreshLink
							url={freshUrl}
							note="Copy it now. Tedix keeps only a fingerprint, so this exact link can't be shown again."
							onDismiss={() => setFreshUrl(null)}
						/>
					</div>
				) : null}
				{access === "public" && publicUrl ? (
					<div data-public-url>
						<PermanentUrl url={publicUrl} />
					</div>
				) : null}
				{links.length > 0 ? (
					<ul className="m-0 grid list-none p-0" data-share-link-list>
						{links.map((link) => (
							<li
								key={link.id}
								className="grid gap-2"
								data-share-link={link.id}
							>
								<div className="flex min-h-10 items-center gap-2">
									<LinkSimple size={14} className="shrink-0 text-kumo-subtle" />
									<span className="grid min-w-0 flex-1">
										<Text as="span" role="body" className="truncate">
											{link.label ?? "Link with sign-in"}
										</Text>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="truncate"
										>
											{ROLE_LABEL[link.role]} · made by{" "}
											{personLabel(link.createdBy)}
										</Text>
									</span>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													size="icon-sm"
													variant="ghost"
													aria-label={`Options for ${link.label ?? "link"}`}
													disabled={busy || copyLink.isPending}
												/>
											}
										>
											<DotsThree size={16} weight="bold" />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() => copyLink.mutate(link.id)}
											>
												<LinkSimple size={14} /> Copy link
											</DropdownMenuItem>
											{link.canEdit ? (
												<DropdownMenuItem
													onClick={() => {
														updateLink.reset();
														setEditingLinkId(link.id);
													}}
												>
													<PencilSimple size={14} /> Edit settings
												</DropdownMenuItem>
											) : null}
											{link.canRevoke ? (
												<DropdownMenuItem
													variant="destructive"
													onClick={() =>
														preview.mutate({
															target: { kind: "link", linkId: link.id },
															label: link.label ?? "this link",
														})
													}
												>
													<Prohibit size={14} /> Turn off
												</DropdownMenuItem>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
								{editingLinkId === link.id ? (
									<LinkSettingsForm
										link={link}
										roleOptions={roleOptions}
										pending={updateLink.isPending}
										error={
											updateLink.isError
												? errorText(updateLink.error, "Couldn't save the link.")
												: null
										}
										onSave={(settings) =>
											updateLink.mutate({ linkId: link.id, ...settings })
										}
										onCancel={() => setEditingLinkId(null)}
									/>
								) : null}
							</li>
						))}
					</ul>
				) : null}
				{createLink.isError || copyLink.isError || publicToggle.isError ? (
					<Text role="label" tone="error" className="m-0">
						{errorText(
							createLink.error ?? copyLink.error ?? publicToggle.error,
							"Couldn't change the link.",
						)}
					</Text>
				) : null}
			</section>
		</>
	);
}

/**
 * A link's label and role, changed in place. The link keeps working and its
 * URL is never shown again.
 */
function LinkSettingsForm(props: {
	link: OsCollaboratorLink;
	roleOptions: OsCollaboratorRole[];
	pending: boolean;
	error: string | null;
	onSave: (settings: { label: string; role: OsCollaboratorRole }) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(props.link.label ?? "");
	const [role, setRole] = useState<OsCollaboratorRole>(props.link.role);
	const options = props.roleOptions.includes(props.link.role)
		? props.roleOptions
		: [...props.roleOptions, props.link.role];
	return (
		<form
			className="grid gap-2 rounded-md border border-kumo-line p-3"
			data-link-settings
			onSubmit={(event) => {
				event.preventDefault();
				props.onSave({ label, role });
			}}
		>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					aria-label="Link name"
					placeholder="Link with sign-in"
					maxLength={120}
					value={label}
					onChange={(event) => setLabel(event.target.value)}
					className="min-w-0 flex-1"
				/>
				<RoleSelect
					ariaLabel="Role for people with this link"
					value={role}
					options={options}
					onChange={setRole}
				/>
			</div>
			<Text role="label" tone="secondary" className="m-0">
				The link stays the same. Everyone who joined through it moves to the new
				role.
			</Text>
			{props.error ? (
				<Text role="label" tone="error" className="m-0" aria-live="polite">
					{props.error}
				</Text>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" size="sm" loading={props.pending}>
					Save
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={props.onCancel}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function RoleSelect(props: {
	ariaLabel: string;
	value: OsCollaboratorRole;
	options: OsCollaboratorRole[];
	onChange: (role: OsCollaboratorRole) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			value={props.value}
			onValueChange={(value) => props.onChange(value as OsCollaboratorRole)}
		>
			<SelectTrigger
				aria-label={props.ariaLabel}
				className="shrink-0"
				disabled={props.disabled}
			>
				<SelectValue>{ROLE_LABEL[props.value]}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{props.options.map((role) => (
					<SelectItem key={role} value={role}>
						{ROLE_LABEL[role]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function PersonRow(props: {
	name: string;
	detail?: string;
	icon?: ReactNode;
	trailing: ReactNode;
	"data-collaborator"?: string;
}) {
	return (
		<li
			className="flex min-h-11 items-center gap-3"
			data-collaborator={props["data-collaborator"]}
		>
			<Avatar size="sm">
				<AvatarFallback>{props.icon ?? initials(props.name)}</AvatarFallback>
			</Avatar>
			<span className="grid min-w-0 flex-1">
				<Text as="span" role="body" className="truncate">
					{props.name}
				</Text>
				{props.detail ? (
					<Text as="span" role="label" tone="secondary" className="truncate">
						{props.detail}
					</Text>
				) : null}
			</span>
			<span className="flex shrink-0 items-center gap-1">{props.trailing}</span>
		</li>
	);
}

/** An organization workspace is open to every member, at build level. */
function EveryoneRow() {
	const context = useOsOperationalContext();
	const organization = context.data?.organization.name ?? "your organization";
	return (
		<PersonRow
			name={`Everyone in ${organization}`}
			icon={<UsersThree size={12} />}
			trailing={
				<Text as="span" role="label" tone="secondary">
					{ROLE_LABEL.build}
				</Text>
			}
		/>
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
				{isLink ? `Turn off ${pending.label}?` : `Remove ${pending.label}?`}
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
						{isLink ? "Turn off link" : "Remove"}
					</Button>
					<Button size="sm" variant="ghost" onClick={props.onCancel}>
						Cancel
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	);
}
