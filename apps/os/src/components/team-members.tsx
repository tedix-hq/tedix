/**
 * Team › Members
 *
 * Member management, backed by the same `members` oRPC contract. Descope tenant membership and
 * role synchronization stay server-side so the browser never needs a Descope
 * management credential.
 *
 * The organization id comes from the credential-resolved operational context —
 * never from the hostname or a path segment. Manage affordances (invite, role
 * change, permission overrides, removal) render only when the caller's
 * authority carries `team:manage`; the list itself is the `team:read` surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	Member,
	MemberRole,
} from "@tedix/api-contract/schemas/organization";
import {
	ASSIGNABLE_ROLES,
	type Permission,
	ROLE_METADATA,
} from "@tedix/auth/rbac";
import {
	ArrowsClockwise,
	DotsThree,
	ShieldCheck,
	Trash,
	UserPlus,
	Users,
	X,
} from "@phosphor-icons/react";
import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import * as z from "zod";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
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
import { Loader } from "@/components/kumo/loader";
import { Pagination } from "@/components/kumo/pagination";
import { Collection } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { MemberAccessDialog } from "@/components/member-access-dialog";
import { osApi } from "@/lib/api";
import {
	MEMBERS_PAGE_SIZE,
	membersListQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { normalizeD1Timestamp, relativeTime } from "@/lib/time";
import { useOsIdentity } from "@/lib/use-os-identity";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Assignable roles minus `owner`: ownership transfer is not a role change.
 * Sourced from the canonical `ASSIGNABLE_ROLES` so a new tenant role appears
 * here without an edit, and a platform role structurally cannot.
 */
export const MANAGEABLE_ROLES = ASSIGNABLE_ROLES.filter(
	(role): role is Exclude<MemberRole, "owner"> => role !== "owner",
);

export const roleLabel = (role: MemberRole): string =>
	ROLE_METADATA[role].label;

export const MAX_INVITE_RECIPIENTS = 20;

const inviteEmailSchema = z.email("Enter a valid email address.");

/** Split pasted or typed recipient text without silently dropping invalid entries. */
export function parseInviteRecipients(
	value: string,
	existing: readonly string[] = [],
): {
	recipients: string[];
	invalid: string[];
	overflow: number;
	unresolved: string[];
} {
	const recipients = [...existing];
	const known = new Set(existing);
	const invalid: string[] = [];
	const unresolved: string[] = [];
	let overflow = 0;
	for (const token of value.split(/[\s,;]+/)) {
		const email = token.trim().toLowerCase();
		if (!email || known.has(email)) continue;
		if (!inviteEmailSchema.safeParse(email).success) {
			invalid.push(token.trim());
			unresolved.push(token.trim());
			continue;
		}
		if (recipients.length >= MAX_INVITE_RECIPIENTS) {
			overflow += 1;
			unresolved.push(token.trim());
			continue;
		}
		known.add(email);
		recipients.push(email);
	}
	return { recipients, invalid, overflow, unresolved };
}

export function memberInitials(member: Pick<Member, "name" | "email">): string {
	const source = member.name?.trim() || member.email;
	return source
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}

export function memberActivityLabel(
	member: Pick<Member, "status" | "invitedAt" | "lastActiveAt">,
): string {
	if (member.status === "invited") {
		return member.invitedAt
			? `Invited ${relativeTime(normalizeD1Timestamp(member.invitedAt))}`
			: "Invited";
	}
	return member.lastActiveAt
		? `Active ${relativeTime(normalizeD1Timestamp(member.lastActiveAt))}`
		: "No recent activity";
}

export function MemberStatusBadge({ status }: { status: Member["status"] }) {
	if (status === "active") return <Badge variant="success">Active</Badge>;
	if (status === "invited") return <Badge variant="secondary">Invited</Badge>;
	if (status === "deactivated") {
		return <Badge variant="destructive">Deactivated</Badge>;
	}
	return <Badge variant="outline">Unknown</Badge>;
}

function mutationErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export async function inviteRecipientsSequentially(
	emails: readonly string[],
	invite: (email: string) => Promise<Member>,
): Promise<{ invited: Member[]; errors: Record<string, string> }> {
	const invited: Member[] = [];
	const errors: Record<string, string> = {};
	for (const email of emails) {
		try {
			invited.push(await invite(email));
		} catch (error) {
			const detail = mutationErrorMessage(
				error,
				"The request did not complete.",
			);
			errors[email] =
				`Unable to confirm this invitation. ${detail} Check the refreshed member list before retrying.`;
		}
	}
	return { invited, errors };
}

function MembersPanelPending() {
	return (
		<Card aria-busy="true" aria-label="Loading members">
			<CardContent className="space-y-3">
				{Array.from({ length: 3 }).map((_, index) => (
					<Skeleton className="h-16 w-full" key={index} />
				))}
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TeamMembersPanel({
	page,
	onPageChange,
}: {
	/** 1-based page from the route's validated search — never component state. */
	page: number;
	onPageChange: (page: number) => void;
}) {
	const context = useOsOperationalContext();
	const identity = useOsIdentity();

	if (context.isPending) return <MembersPanelPending />;
	if (context.isError || !context.data) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Membership is unavailable</AlertTitle>
				<AlertDescription>
					{mutationErrorMessage(
						context.error,
						"The operational context read failed.",
					)}
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<TeamMembersPanelBody
			canManage={context.data.authority.permissions.includes("team:manage")}
			identityEmail={identity.email}
			isPersonalOrg={context.data.organization.type === "personal"}
			onPageChange={onPageChange}
			organizationId={context.data.organization.id}
			page={page}
		/>
	);
}

function TeamMembersPanelBody({
	organizationId,
	canManage,
	isPersonalOrg,
	identityEmail,
	page,
	onPageChange,
}: {
	organizationId: string;
	canManage: boolean;
	isPersonalOrg: boolean;
	identityEmail: string;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const queryClient = useQueryClient();
	const offset = (page - 1) * MEMBERS_PAGE_SIZE;
	const [showInvite, setShowInvite] = useState(false);
	const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
	const [memberToAudit, setMemberToAudit] = useState<Member | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const membersQuery = useQuery({
		...membersListQueryOptions({
			organizationId,
			limit: MEMBERS_PAGE_SIZE,
			offset,
		}),
		staleTime: 30_000,
	});

	function invalidateMembers() {
		return queryClient.invalidateQueries({ queryKey: osQueryKeys.members() });
	}

	const permissionsMutation = useMutation({
		mutationFn: (input: { memberId: string; permissions: Permission[] }) =>
			osApi.members.setMemberPermissions({
				organizationId,
				memberId: input.memberId,
				permissions: input.permissions,
			}),
		onSuccess: async (result) => {
			await invalidateMembers();
			setMemberToAudit(null);
			setNotice(`Updated permissions for ${result.data.email}`);
		},
	});

	const roleMutation = useMutation({
		mutationFn: ({ memberId, role }: { memberId: string; role: MemberRole }) =>
			osApi.members.updateMemberRole({ organizationId, memberId, role }),
		onSuccess: async ({ data: updated }) => {
			await invalidateMembers();
			setNotice(`${updated.email} is now ${roleLabel(updated.role)}`);
		},
	});

	const removeMutation = useMutation({
		mutationFn: (member: Member) =>
			osApi.members.removeMember({ organizationId, memberId: member.id }),
		onSuccess: async (_result, member) => {
			setMemberToRemove(null);
			await invalidateMembers();
			setNotice(`${member.email} was removed from the team`);
		},
	});

	if (membersQuery.isPending) return <MembersPanelPending />;
	if (membersQuery.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>The member list is unavailable</AlertTitle>
				<AlertDescription>
					{mutationErrorMessage(
						membersQuery.error,
						"The membership read failed.",
					)}
				</AlertDescription>
			</Alert>
		);
	}

	const data = membersQuery.data;
	const members = data.data;
	const normalizedIdentityEmail = identityEmail.trim().toLowerCase();
	const isCurrentUser = (member: Member) =>
		normalizedIdentityEmail.length > 0 &&
		member.email.toLowerCase() === normalizedIdentityEmail;
	const actionError =
		roleMutation.error ?? removeMutation.error ?? permissionsMutation.error;

	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<Users className="size-5 text-kumo-subtle" />
								<CardTitle>Members ({data.pagination.total})</CardTitle>
							</div>
							<CardDescription className="mt-1">
								Roles control what each person can see and manage in this
								workspace.
							</CardDescription>
						</div>
						<div className="flex items-center gap-2">
							<Tooltip>
								<TooltipTrigger
									render={
										<Button
											aria-label="Refresh team members"
											disabled={membersQuery.isFetching}
											onClick={() => void membersQuery.refetch()}
											size="icon-sm"
											variant="ghost"
										/>
									}
								>
									{membersQuery.isFetching ? (
										<Loader size="sm" />
									) : (
										<ArrowsClockwise className="size-4" />
									)}
								</TooltipTrigger>
								<TooltipContent>Refresh members</TooltipContent>
							</Tooltip>
							{canManage ? (
								<Button
									disabled={isPersonalOrg}
									onClick={() => setShowInvite(true)}
									size="sm"
									title={
										isPersonalOrg
											? "Personal workspaces do not support team invitations"
											: undefined
									}
								>
									<UserPlus className="size-4" />
									Invite member
								</Button>
							) : null}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{notice ? (
						<Text
							aria-live="polite"
							role="body"
							tone="secondary"
							className="mb-3"
						>
							{notice}
						</Text>
					) : null}
					{actionError ? (
						<Alert className="mb-3" variant="destructive">
							<AlertTitle>The last member action failed</AlertTitle>
							<AlertDescription>
								{mutationErrorMessage(actionError, "The request failed.")}
							</AlertDescription>
						</Alert>
					) : null}

					<div className="hidden md:block">
						<Table aria-label="Team members">
							<TableHeader>
								<TableRow>
									<TableHead>Person</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Activity</TableHead>
									<TableHead className="w-12">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{members.map((member) => {
									const self = isCurrentUser(member);
									const canEditMember =
										canManage && member.role !== "owner" && !self;

									return (
										<TableRow key={member.id}>
											<TableCell>
												<div className="flex min-w-48 items-center gap-3">
													<Avatar>
														{member.avatarUrl ? (
															<AvatarImage
																alt={member.name ?? member.email}
																src={member.avatarUrl}
															/>
														) : null}
														<AvatarFallback>
															{memberInitials(member)}
														</AvatarFallback>
													</Avatar>
													<div className="min-w-0">
														<div className="flex items-center gap-2">
															<Text
																as="span"
																role="body"
																weight="medium"
																className="truncate"
															>
																{member.name || member.email}
															</Text>
															{self ? (
																<Badge variant="outline">You</Badge>
															) : null}
														</div>
														{member.name ? (
															<Text
																role="label"
																tone="secondary"
																className="truncate"
															>
																{member.email}
															</Text>
														) : null}
													</div>
												</div>
											</TableCell>
											<TableCell>
												<MemberStatusBadge status={member.status} />
											</TableCell>
											<TableCell>
												{canEditMember ? (
													<Select
														disabled={roleMutation.isPending}
														onValueChange={(value) => {
															if (!value || value === member.role) return;
															roleMutation.mutate({
																memberId: member.id,
																role: value as MemberRole,
															});
														}}
														value={member.role}
													>
														<SelectTrigger
															aria-label={`Role for ${member.email}`}
															className="w-32"
															size="sm"
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{MANAGEABLE_ROLES.map((role) => (
																<SelectItem key={role} value={role}>
																	{roleLabel(role)}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												) : (
													<Badge variant="secondary">
														{roleLabel(member.role)}
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-kumo-subtle">
												{memberActivityLabel(member)}
											</TableCell>
											<TableCell>
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button
																aria-label={`Actions for ${member.email}`}
																size="icon-sm"
																variant="ghost"
															/>
														}
													>
														<DotsThree className="size-4" weight="bold" />
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onClick={() => setMemberToAudit(member)}
														>
															<ShieldCheck className="size-4" />
															View access
														</DropdownMenuItem>
														{canEditMember ? (
															<DropdownMenuItem
																onClick={() => setMemberToRemove(member)}
																variant="destructive"
															>
																<Trash className="size-4" />
																Remove member
															</DropdownMenuItem>
														) : null}
													</DropdownMenuContent>
												</DropdownMenu>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>

					<Collection
						appearance="inline"
						aria-label="Organization members"
						className="md:hidden"
					>
						{members.map((member) => {
							const self = isCurrentUser(member);
							const canEditMember =
								canManage && member.role !== "owner" && !self;

							return (
								<li
									className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
									key={member.id}
								>
									<Avatar className="shrink-0">
										{member.avatarUrl ? (
											<AvatarImage
												alt={member.name ?? member.email}
												src={member.avatarUrl}
											/>
										) : null}
										<AvatarFallback>{memberInitials(member)}</AvatarFallback>
									</Avatar>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<Text
												as="h3"
												role="body"
												weight="medium"
												className="truncate"
											>
												{member.name || member.email}
											</Text>
											{self ? <Badge variant="outline">You</Badge> : null}
										</div>
										{member.name ? (
											<Text
												role="label"
												tone="secondary"
												className="mt-0.5 truncate"
											>
												{member.email}
											</Text>
										) : null}
									</div>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													aria-label={`Actions for ${member.email}`}
													size="icon-sm"
													variant="ghost"
												/>
											}
										>
											<DotsThree className="size-4" weight="bold" />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() => setMemberToAudit(member)}
											>
												<ShieldCheck className="size-4" />
												View access
											</DropdownMenuItem>
											{canEditMember ? (
												<DropdownMenuItem
													onClick={() => setMemberToRemove(member)}
													variant="destructive"
												>
													<Trash className="size-4" />
													Remove member
												</DropdownMenuItem>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>

									<div className="col-span-2 col-start-2 flex min-w-0 items-center justify-between gap-3">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<MemberStatusBadge status={member.status} />
											<Text role="label" tone="secondary" className="truncate">
												{memberActivityLabel(member)}
											</Text>
										</div>
										<div className="shrink-0">
											{canEditMember ? (
												<Select
													disabled={roleMutation.isPending}
													onValueChange={(value) => {
														if (!value || value === member.role) return;
														roleMutation.mutate({
															memberId: member.id,
															role: value as MemberRole,
														});
													}}
													value={member.role}
												>
													<SelectTrigger
														aria-label={`Role for ${member.email}`}
														className="w-32"
														size="sm"
													>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{MANAGEABLE_ROLES.map((role) => (
															<SelectItem key={role} value={role}>
																{roleLabel(role)}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											) : (
												<Badge variant="secondary">
													{roleLabel(member.role)}
												</Badge>
											)}
										</div>
									</div>
								</li>
							);
						})}
					</Collection>

					{data.pagination.total > 0 ? (
						<Pagination
							className="mt-4 flex-col items-stretch gap-3 border-t pt-4 sm:flex-row sm:items-center"
							page={page}
							perPage={MEMBERS_PAGE_SIZE}
							totalCount={data.pagination.total}
							setPage={onPageChange}
						>
							<Pagination.Info />
							<Pagination.Controls controls="simple" />
						</Pagination>
					) : null}
				</CardContent>
			</Card>

			{showInvite ? (
				<InviteMemberDialog
					organizationId={organizationId}
					onCancel={() => setShowInvite(false)}
					onSettled={async (members) => {
						await invalidateMembers();
						if (members.length > 0) {
							setNotice(
								members.length === 1
									? `Invitation created for ${members[0]?.email}`
									: `${members.length} invitations created`,
							);
						}
					}}
				/>
			) : null}

			<MemberAccessDialog
				canManage={canManage}
				isSaving={permissionsMutation.isPending}
				member={memberToAudit}
				onClose={() => setMemberToAudit(null)}
				onSave={(memberId, permissions) =>
					permissionsMutation.mutate({ memberId, permissions })
				}
			/>

			<AlertDialog
				open={Boolean(memberToRemove)}
				onOpenChange={(open) => {
					if (open) return;
					if (removeMutation.isPending) return;
					removeMutation.reset();
					setMemberToRemove(null);
				}}
			>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Remove team member?</AlertDialogTitle>
						<AlertDialogDescription>
							{memberToRemove?.email} will lose access to this workspace. You
							can invite them again later.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{removeMutation.isError ? (
						<Alert variant="destructive">
							<AlertTitle>The member could not be removed</AlertTitle>
							<AlertDescription>
								{mutationErrorMessage(
									removeMutation.error,
									"The request failed.",
								)}
							</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={removeMutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={!memberToRemove || removeMutation.isPending}
							onClick={(event) => {
								// Dialog.Close closes on click regardless of preventDefault;
								// the dialog stays open until the removal settles.
								event.preventBaseUIHandler();
								if (memberToRemove) removeMutation.mutate(memberToRemove);
							}}
							variant="destructive"
						>
							{removeMutation.isPending ? "Removing…" : "Remove member"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export function InviteMemberDialog({
	organizationId,
	onSettled,
	onCancel,
}: {
	organizationId: string;
	onSettled: (members: Member[]) => void | Promise<void>;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [recipients, setRecipients] = useState<string[]>([]);
	const [role, setRole] = useState<Exclude<MemberRole, "owner">>("member");
	const [recipientErrors, setRecipientErrors] = useState<
		Record<string, string>
	>({});
	const [composerError, setComposerError] = useState<string | null>(null);

	const stage = (value: string): boolean => {
		const parsed = parseInviteRecipients(value, recipients);
		setRecipients(parsed.recipients);
		setDraft(parsed.unresolved.join(", "));
		if (parsed.invalid.length > 0) {
			setComposerError(
				`Check ${parsed.invalid.length === 1 ? "this address" : "these addresses"}: ${parsed.invalid.join(", ")}`,
			);
			return false;
		}
		if (parsed.overflow > 0) {
			setComposerError(
				`You can invite up to ${MAX_INVITE_RECIPIENTS} people at once.`,
			);
			return false;
		}
		setComposerError(null);
		return true;
	};

	const inviteMutation = useMutation({
		mutationFn: (emails: string[]) =>
			inviteRecipientsSequentially(emails, async (email) => {
				const { data } = await osApi.members.inviteMember({
					organizationId,
					email,
					role,
				});
				return data;
			}),
		onSuccess: async ({ invited, errors }) => {
			setRecipientErrors(errors);
			setRecipients((current) => current.filter((email) => email in errors));
			await onSettled(invited);
			if (Object.keys(errors).length === 0) onCancel();
		},
	});
	const submit = () => {
		const before = recipients;
		if (draft.trim() && !stage(draft)) return;
		const next = draft.trim()
			? parseInviteRecipients(draft, before).recipients
			: before;
		if (next.length === 0) {
			setComposerError("Add at least one email address.");
			return;
		}
		setRecipientErrors({});
		inviteMutation.mutate(next);
	};
	const handleComposerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter" || event.key === "," || event.key === ";") {
			event.preventDefault();
			stage(draft);
		}
	};
	const handleComposerPaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const pasted = event.clipboardData.getData("text");
		if (!/[\s,;]/.test(pasted)) return;
		event.preventDefault();
		const start = event.currentTarget.selectionStart ?? draft.length;
		const end = event.currentTarget.selectionEnd ?? start;
		stage(`${draft.slice(0, start)}${pasted}${draft.slice(end)}`);
	};
	const pending = inviteMutation.isPending;

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
			<DialogContent size="lg">
				<DialogHeader>
					<DialogTitle>Invite team members</DialogTitle>
					<DialogDescription>
						Add up to {MAX_INVITE_RECIPIENTS} people and choose the access they
						should receive when they join this workspace.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="grid gap-2">
						<label className="text-sm font-medium" htmlFor="invite-recipients">
							Email addresses
						</label>
						{recipients.length > 0 ? (
							<div
								className="flex flex-wrap gap-2"
								aria-label="Invitation recipients"
							>
								{recipients.map((email) => (
									<Badge
										key={email}
										variant={recipientErrors[email] ? "error" : "secondary"}
									>
										<span>{email}</span>
										<Button
											aria-label={`Remove ${email}`}
											className="-my-1 -mr-1 ml-1"
											disabled={pending}
											onClick={() => {
												setRecipients((current) =>
													current.filter((item) => item !== email),
												);
												setRecipientErrors((current) => {
													const next = { ...current };
													delete next[email];
													return next;
												});
											}}
											size="icon-sm"
											type="button"
											variant="ghost"
										>
											<X aria-hidden size={14} />
										</Button>
									</Badge>
								))}
							</div>
						) : null}
						<Input
							id="invite-recipients"
							autoComplete="email"
							disabled={pending || recipients.length >= MAX_INVITE_RECIPIENTS}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={handleComposerKeyDown}
							onPaste={handleComposerPaste}
							placeholder="name@company.com"
							value={draft}
						/>
						<Text as="p" role="label" tone="secondary" className="m-0">
							Separate addresses with Enter, commas, spaces, or new lines.
						</Text>
					</div>
					<div className="grid gap-2">
						<label className="text-sm font-medium" htmlFor="invite-role">
							Role
						</label>
						<Select
							value={role}
							onValueChange={(value) =>
								setRole(value as Exclude<MemberRole, "owner">)
							}
							disabled={pending}
						>
							<SelectTrigger id="invite-role">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{MANAGEABLE_ROLES.map((option) => (
									<SelectItem key={option} value={option}>
										{roleLabel(option)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Text as="p" role="label" tone="secondary" className="m-0">
							Admins can manage workspace settings. Members can create and
							configure resources. Viewers have read-only access.
						</Text>
					</div>
					{composerError ? (
						<Alert variant="destructive">
							<AlertTitle>Check the recipients</AlertTitle>
							<AlertDescription>{composerError}</AlertDescription>
						</Alert>
					) : null}
					{Object.entries(recipientErrors).map(([email, message]) => (
						<Alert key={email} variant="destructive">
							<AlertTitle>{`Invitation not confirmed for ${email}`}</AlertTitle>
							<AlertDescription>{message}</AlertDescription>
						</Alert>
					))}
					<DialogFooter>
						<Button
							disabled={pending}
							onClick={onCancel}
							type="button"
							variant="outline"
						>
							Cancel
						</Button>
						<Button disabled={pending} type="submit">
							{pending
								? "Creating…"
								: `Create ${recipients.length > 1 ? `${recipients.length} invitations` : "invitation"}`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
