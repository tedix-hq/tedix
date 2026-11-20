import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	tediNamesQueryOptions,
	workspacePresenceQueryOptions,
} from "@/lib/os-query-options";
import { mayPickWorkspaceTedi } from "@/lib/workspace-guest-tedi";

/**
 * Shared tedi display-name map (id → name), cached under the one generated
 * `tedis.list({})` key so every surface resolves names from the same read.
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
 * Active tedis a chat message can be sent to, from the same `tedis.list({})`
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
 * ones the workspace accepts. The person's id comes from the presence read
 * of `workspaceId`; without it only the organization's tedis are offered.
 */
export function usePickableTedis(
	workspaceId: string | null | undefined,
): { id: string; name: string }[] {
	const tedis = useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	});
	const presence = useQuery({
		...workspacePresenceQueryOptions(workspaceId ?? ""),
		enabled:
			Boolean(workspaceId) &&
			(tedis.data?.data ?? []).some((tedi) => tedi.scope === "personal"),
	});
	const userId = presence.data?.userId;
	return useMemo(
		() =>
			(tedis.data?.data ?? [])
				.filter((tedi) => mayPickWorkspaceTedi(tedi, userId))
				.map((tedi) => ({ id: tedi.id, name: tedi.displayName ?? tedi.name })),
		[tedis.data, userId],
	);
}

/** True until the first read of the organization's tedis has answered. */
export function useTediRosterPending(): boolean {
	return useQuery({
		...tediNamesQueryOptions(),
		staleTime: 60_000,
	}).isPending;
}
