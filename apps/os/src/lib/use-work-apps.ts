import { useQuery } from "@tanstack/react-query";
import { workRefreshOptions } from "@/lib/work-refresh";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { workAppsQueryOptions } from "@/lib/os-query-options";

function workAppRole(manifest: OsGadgetManifest): "feed" | "deck" | null {
	if (manifest.navigation?.work) return manifest.navigation.work;
	if (!manifest.navigation?.board) return null;
	if (manifest.entry === "tedix:app/activity-feed") return "feed";
	if (manifest.entry === "tedix:app/decision-deck") return "deck";
	return null;
}

/** One viewer-scoped read replaces workspace → list → revision waterfalls. */
export function useWorkApps() {
	const query = useQuery({ ...workAppsQueryOptions(), ...workRefreshOptions });
	const apps = (query.data?.items ?? []).map((data) => ({
		gadget: data.gadget,
		manifest: data.currentRevision.manifest,
		role: workAppRole(data.currentRevision.manifest),
	}));
	return {
		apps,
		pending: query.isPending,
		failed: query.isError,
		truncated: Boolean(query.data?.truncated),
		retry: () => {
			void query.refetch();
		},
	};
}
