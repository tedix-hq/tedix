import { Pagination } from "@/components/kumo/pagination";
import { Text } from "@/components/kumo/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Member } from "@tedix/api-contract/schemas/organization";
import { isAgentMemberKind } from "@tedix/api-contract/schemas/browser-agent-seat";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import {
	MEMBERS_PAGE_SIZE,
	membersListQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

export function memberIdentityLabel(member: Member): string {
	const name = member.name || member.email;
	return isAgentMemberKind(member.kind)
		? `${name} · ${member.representedUserName ? `agent for ${member.representedUserName}` : "external agent"}`
		: name;
}

export function MemberIdentityDialog({
	member,
	onClose,
}: {
	member: Member;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [kind, setKind] = useState(member.kind ?? "human");
	const [displayName, setDisplayName] = useState(member.name ?? "");
	const [representedUserId, setRepresentedUserId] = useState(
		member.representedUserId ?? "",
	);
	const [representedName, setRepresentedName] = useState(
		member.representedUserName ?? "",
	);
	const [avatarUrl, setAvatarUrl] = useState(
		isAgentMemberKind(member.kind) ? (member.avatarUrl ?? "") : "",
	);
	const avatarUrlValid =
		avatarUrl.trim() === "" || /^https?:\/\/\S+$/.test(avatarUrl.trim());
	const [page, setPage] = useState(0);
	const people = useQuery(
		membersListQueryOptions({
			organizationId: member.organizationId,
			limit: MEMBERS_PAGE_SIZE,
			offset: page * MEMBERS_PAGE_SIZE,
		}),
	);
	const save = useMutation({
		mutationFn: () =>
			osApi.members.setMemberIdentity({
				organizationId: member.organizationId,
				memberId: member.id,
				identity: isAgentMemberKind(kind)
					? {
							kind,
							displayName,
							representedUserId,
							avatarUrl: avatarUrl.trim() || null,
						}
					: { kind },
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.members() });
			onClose();
		},
	});
	const suspend = useMutation({
		mutationFn: () =>
			osApi.members.suspendAgentSeat({
				organizationId: member.organizationId,
				memberId: member.id,
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.members() });
			onClose();
		},
	});
	const error = save.error ?? suspend.error;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !save.isPending && !suspend.isPending) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Member identity</DialogTitle>
					<DialogDescription>
						Choose a display label or a browser agent seat. A browser seat uses
						its own login with member or viewer access and cannot approve
						actions or manage the team. Suspend blocks its next API request. A
						display label keeps existing access.
					</DialogDescription>
				</DialogHeader>
				<Select
					value={kind}
					onValueChange={(value) => {
						if (
							value === "human" ||
							value === "external_agent" ||
							value === "browser_agent"
						)
							setKind(value);
					}}
				>
					<SelectTrigger aria-label="Member kind">
						<SelectValue>
							{kind === "human"
								? "Person"
								: kind === "browser_agent"
									? "Browser agent seat"
									: "External agent label"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="human">Person</SelectItem>
						<SelectItem value="external_agent">External agent</SelectItem>
						<SelectItem value="browser_agent">Browser agent seat</SelectItem>
					</SelectContent>
				</Select>
				{isAgentMemberKind(kind) ? (
					<>
						<Input
							aria-label="Agent name"
							placeholder="Agent name"
							value={displayName}
							maxLength={100}
							onChange={(event) => setDisplayName(event.target.value)}
						/>
						<Select
							value={representedUserId}
							onValueChange={(value) => {
								if (value) {
									setRepresentedUserId(value);
									const person = people.data?.data.find(
										(person) => person.userId === value,
									);
									setRepresentedName(
										person?.name || person?.email || "Selected person",
									);
								}
							}}
						>
							<SelectTrigger aria-label="Person represented">
								<SelectValue placeholder="Choose the person represented">
									{representedName || undefined}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{(people.data?.data ?? [])
									.filter(
										(person) =>
											person.id !== member.id &&
											person.status === "active" &&
											!isAgentMemberKind(person.kind) &&
											person.userId,
									)
									.map((person) => (
										<SelectItem key={person.id} value={person.userId!}>
											{person.name || person.email}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
						{people.isError ? (
							<div role="alert">
								<Text role="label" tone="error">
									The people list could not be loaded.
								</Text>
							</div>
						) : null}
						<Input
							aria-label="Agent avatar URL"
							aria-invalid={!avatarUrlValid}
							placeholder="Agent avatar URL (optional)"
							type="url"
							value={avatarUrl}
							maxLength={2048}
							onChange={(event) => setAvatarUrl(event.target.value)}
						/>
						{people.data && people.data.pagination.total > MEMBERS_PAGE_SIZE ? (
							<Pagination
								page={page + 1}
								perPage={MEMBERS_PAGE_SIZE}
								totalCount={people.data.pagination.total}
								setPage={(next) => setPage(next - 1)}
							>
								<Pagination.Controls controls="simple" />
							</Pagination>
						) : null}
					</>
				) : null}
				{error ? (
					<div role="alert">
						<Text role="label" tone="error">
							{error instanceof Error
								? error.message
								: "Identity could not be saved."}
						</Text>
					</div>
				) : null}
				<DialogFooter>
					{member.kind === "browser_agent" && member.status === "active" ? (
						<Button
							variant="destructive"
							disabled={save.isPending || suspend.isPending}
							onClick={() => suspend.mutate()}
						>
							Suspend agent
						</Button>
					) : null}
					<Button
						variant="secondary"
						disabled={save.isPending || suspend.isPending}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						disabled={
							save.isPending ||
							suspend.isPending ||
							(isAgentMemberKind(kind) &&
								(!displayName.trim() || !representedUserId || !avatarUrlValid))
						}
						onClick={() => save.mutate()}
					>
						Save identity
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
