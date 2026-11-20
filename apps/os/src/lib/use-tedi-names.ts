import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	osQuery,
	tediDetailQueryOptions,
	tediNamesQueryOptions,
} from "@/lib/os-query-options";
import { mayPickWorkspaceTedi } from "@/lib/workspace-guest-tedi";

/**
 * Shared tedi display-name map (id → name), cached under the one generated
 * `tedis.list` key so every surface resolves names from the same read.
 */
export function useTediNames(): Record<string, string> {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	return useMemo(() => {
		const names: Record<string, string> = {};
		for (const tedi of tedis.data?.data ?? []) {
			names[tedi.id] = tedi.displayName ?? tedi.name;
		}
		return names;
	}, [tedis.data]);
}

/**
 * Active tedis a chat message can be sent to, from the same `tedis.list`
 * read as {@link useTediNames}, so the composer picker adds no request.
 */
export function useActiveTedis(): { id: string; name: string }[] {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	return useMemo(
		() =>
			(tedis.data?.data ?? [])
				.filter((tedi) => tedi.status === "active")
				.map((tedi) => ({ id: tedi.id, name: tedi.displayName ?? tedi.name })),
		[tedis.data],
	);
}

/**
 * The tedis this person may pick to answer in a workspace chat: exactly the
 * ones the workspace accepts. A personal tedi's owner is recorded under the
 * person's sign-in id, not the account profile's id, so the person's id is
 * the owner of their own private workspace, the same id the workspace checks.
 */
export function usePickableTedis(): { id: string; name: string }[] {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	const userId =
		useQuery({
			...osQuery.osWorkspaces.workspaces.personal.queryOptions({
				input: { create: false },
			}),
			staleTime: Number.POSITIVE_INFINITY,
		}).data?.workspace?.ownerUserId ?? undefined;
	return useMemo(
		() =>
			(tedis.data?.data ?? [])
				.filter((tedi) => mayPickWorkspaceTedi(tedi, userId))
				.map((tedi) => ({ id: tedi.id, name: tedi.displayName ?? tedi.name })),
		[tedis.data, userId],
	);
}

/** Name and avatar of each tedi, from the same read as {@link useTediNames}. */
export function useTediProfiles(): Record<
	string,
	{ name: string; avatar: string | null }
> {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	return useMemo(() => {
		const profiles: Record<string, { name: string; avatar: string | null }> =
			{};
		for (const tedi of tedis.data?.data ?? []) {
			profiles[tedi.id] = {
				name: tedi.displayName ?? tedi.name,
				avatar: tedi.avatar ?? null,
			};
		}
		return profiles;
	}, [tedis.data]);
}

/**
 * One tedi's name: from the shared roster page, or read by its id when the
 * tedi is not on that page. Undefined while it is unknown.
 */
export function useTediName(tediId: string | null): string | undefined {
	const names = useTediNames();
	const roster = useQuery({ ...tediNamesQueryOptions(), staleTime: 60_000 });
	const listed = tediId ? names[tediId] : undefined;
	const read = useQuery({
		...tediDetailQueryOptions(tediId ?? ""),
		enabled: tediId !== null && roster.isSuccess && listed === undefined,
		staleTime: 60_000,
	});
	return (
		listed ??
		(read.data ? (read.data.displayName ?? read.data.name) : undefined)
	);
}

/** True until the first read of the organization's tedis has answered. */
export function useTediRosterPending(): boolean {
	return useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	}).isPending;
}
