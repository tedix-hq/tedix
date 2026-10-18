import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import {
	WorkActorDirectoryContext,
	WorkActorOwnerContext,
} from "@/components/work-actor-avatar";
import type { ActorProfile } from "@/lib/work-actor";
import {
	membersListQueryOptions,
	operationalContextQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workExternalPrincipalsQueryOptions,
} from "@/lib/os-query-options";

export function WorkActorDirectory({ children }: { children: ReactNode }) {
	const context = useQuery(operationalContextQueryOptions());
	const organizationId = context.data?.organization.id;
	const profile = useQuery(userProfileQueryOptions());
	const tedis = useQuery({
		...tediRosterQueryOptions(100),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const members = useQuery({
		...membersListQueryOptions({
			organizationId: organizationId ?? "",
			limit: 100,
			offset: 0,
		}),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const external = useQuery({
		...workExternalPrincipalsQueryOptions(organizationId ?? ""),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const directory = useMemo(() => {
		const rows = new Map<string, ActorProfile>();
		for (const tedi of tedis.data?.data ?? [])
			rows.set(`tedi:${tedi.id}`, {
				name: tedi.displayName || tedi.name,
				image: tedi.avatar,
			});
		for (const member of members.data?.data ?? []) {
			const memberProfile = {
				name: member.name || member.email,
				image: member.avatarUrl,
			};
			rows.set(`user:${member.descopeUserId}`, memberProfile);
			if (member.userId) rows.set(`user:${member.userId}`, memberProfile);
		}
		if (profile.data)
			rows.set(`user:${profile.data.id}`, {
				name: profile.data.name || profile.data.email,
				image:
					profile.data.avatarUrl ?? rows.get(`user:${profile.data.id}`)?.image,
			});
		for (const principal of external.data ?? [])
			rows.set(`external_agent:${principal.id}`, {
				name: principal.displayName,
				for:
					principal.credentialBindingType === "owner_user"
						? rows.get(`user:${principal.credentialBindingId}`)
						: principal.createdByType === "user"
							? rows.get(`user:${principal.createdById}`)
							: undefined,
			});
		return rows;
	}, [tedis.data, members.data, external.data, profile.data]);
	return (
		<WorkActorDirectoryContext.Provider value={directory}>
			<WorkActorOwnerContext.Provider value={profile.data?.id}>
				{children}
			</WorkActorOwnerContext.Provider>
		</WorkActorDirectoryContext.Provider>
	);
}
