/**
 * Durable preference state for the Tedix OS shell.
 *
 * The server row is authoritative; `localStorage` stays only as the pre-paint
 * theme cache (`index.html` inlines a mirror of it, so removing it would
 * reintroduce the first-paint flash). On every successful read or write the
 * server value is pushed back through `applyOsPreferences`, so the cache can
 * never outlive the row it mirrors.
 *
 * Concurrency is the contract's: every save carries the `revision` the client
 * last read, and a lost compare-and-swap comes back as a typed `CONFLICT`. The
 * mutation deliberately does NOT auto-retry — the other tab's values are a real
 * edit, and silently replaying over them is exactly the clobber the CAS exists
 * to prevent. It refetches and surfaces the conflict instead.
 */

import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { osApi } from "@/lib/api";
import { applyOsPreferences } from "@/lib/os-presentation";
import { setOrganizationTheme } from "@/lib/organization-theme";
import {
	operationalContextQueryOptions,
	userPreferencesQueryOptions,
} from "@/lib/os-query-options";

export function isRevisionConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "CONFLICT"
	);
}

export function useOsPreferences() {
	const queryClient = useQueryClient();
	const queryOptions = userPreferencesQueryOptions();
	const query = useQuery(queryOptions);

	// Apply on arrival AND on every subsequent change, including the value a
	// refetch pulls in after another tab saved.
	const state = query.data;
	useEffect(() => {
		if (state) applyOsPreferences(state.preferences);
	}, [state]);

	const save = useMutation({
		mutationFn: (preferences: OsUserPreferences) =>
			osApi.userSettings.updatePreferences({
				preferences,
				expectedRevision: query.data?.revision ?? 0,
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(queryOptions.queryKey, next);
		},
		onError: (error) => {
			// A conflict means the stored row moved. Pull the winner in so the
			// operator sees the values that actually survived, not their own.
			if (isRevisionConflict(error)) {
				void queryClient.invalidateQueries({
					queryKey: queryOptions.queryKey,
				});
			}
		},
	});

	return { query, save };
}

const THEME_CYCLE = {
	system: "light",
	light: "dark",
	dark: "system",
} as const;

/**
 * Shell-chrome theme control, and the app-wide hydration point.
 *
 * Mounting this in the shell is what makes the durable preferences apply to
 * EVERY surface rather than only to the settings page. The cycle button applies
 * the new mode locally first so the chrome stays instant, then persists it — if
 * that write loses its compare-and-swap, the refetch pushes the surviving value
 * back through `applyOsPreferences`, so the optimistic flip corrects itself
 * instead of drifting from the row.
 */
export function useOsDurableTheme() {
	const { query, save } = useOsPreferences();
	const preferences = query.data?.preferences;
	return {
		preference: preferences?.theme ?? "system",
		cycleTheme: () => {
			if (!preferences) return;
			const theme = THEME_CYCLE[preferences.theme];
			applyOsPreferences({ ...preferences, theme });
			save.mutate({ ...preferences, theme });
		},
	} as const;
}

export function useOsOperationalContext() {
	return useQuery(operationalContextQueryOptions());
}

/** Applies the credential-scoped organization theme once for the shell. */
export function useOsOrganizationTheme(): void {
	const context = useOsOperationalContext();
	useEffect(() => {
		if (context.data)
			setOrganizationTheme(context.data.organization.appearance);
	}, [context.data]);
}
