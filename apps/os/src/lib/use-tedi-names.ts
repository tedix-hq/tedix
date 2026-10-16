import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { tediNamesQueryOptions } from "@/lib/os-query-options";

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
