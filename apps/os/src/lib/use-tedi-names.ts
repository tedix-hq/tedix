import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	tediNamesQueryOptions,
	userProfileQueryOptions,
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
 * ones the workspace accepts. The person's id comes from the signed-in
 * profile, so their personal tedis are offered before any workspace exists.
 */
export function usePickableTedis(): { id: string; name: string }[] {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	const userId = useQuery(userProfileQueryOptions()).data?.id;
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

/** True until the first read of the organization's tedis has answered. */
export function useTediRosterPending(): boolean {
	return useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	}).isPending;
}
