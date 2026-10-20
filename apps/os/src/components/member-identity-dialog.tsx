import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Member } from "@tedix/api-contract/schemas/organization";
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
	return member.kind === "external_agent"
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
		member.kind === "external_agent" ? (member.avatarUrl ?? "") : "",
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
				identity:
					kind === "external_agent"
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
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !save.isPending) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Member identity</DialogTitle>
					<DialogDescription>
						Label this member as a person or an external agent. Representation
						does not grant access to the person's private data or decisions.
					</DialogDescription>
				</DialogHeader>
				<Select
					value={kind}
					onValueChange={(value) => {
						if (value === "human" || value === "external_agent") setKind(value);
					}}
				>
					<SelectTrigger aria-label="Member kind">
						<SelectValue>
							{kind === "human" ? "Person" : "External agent"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="human">Person</SelectItem>
						<SelectItem value="external_agent">External agent</SelectItem>
					</SelectContent>
				</Select>
				{kind === "external_agent" ? (
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
											person.kind !== "external_agent" &&
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
							<p role="alert">The people list could not be loaded.</p>
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
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="secondary"
									disabled={page === 0}
									onClick={() => setPage(page - 1)}
								>
									Previous people
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={!people.data.pagination.hasMore}
									onClick={() => setPage(page + 1)}
								>
									More people
								</Button>
							</div>
						) : null}
					</>
				) : null}
				{save.error ? (
					<p role="alert">
						{save.error instanceof Error
							? save.error.message
							: "Identity could not be saved."}
					</p>
				) : null}
				<DialogFooter>
					<Button
						variant="secondary"
						disabled={save.isPending}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						disabled={
							save.isPending ||
							(kind === "external_agent" &&
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
