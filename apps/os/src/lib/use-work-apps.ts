import { useQueries, useQuery } from "@tanstack/react-query";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";

function workAppRole(manifest: OsGadgetManifest): "feed" | "deck" | null {
	if (manifest.navigation?.work) return manifest.navigation.work;
	if (!manifest.navigation?.board) return null;
	if (manifest.entry === "tedix:app/activity-feed") return "feed";
	if (manifest.entry === "tedix:app/decision-deck") return "deck";
	return null;
}

/** Workspace authorization, rather than an org-wide gadget catalog, bounds discovery. */
export function useWorkApps() {
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const lists = useQueries({
		queries: (workspaces.data?.items ?? []).map((workspace) =>
			canvasGadgetsQueryOptions(workspace.id),
		),
	});
	const gadgets = lists
		.flatMap((list) => list.data?.items ?? [])
		.filter((gadget) => gadget.status === "active");
	const details = useQueries({
		queries: gadgets.map((gadget) =>
			canvasGadgetDetailQueryOptions(gadget.workspaceId, gadget.id),
		),
	});
	const apps = details
		.flatMap((detail) => {
			const data = detail.data;
			const manifest = data?.currentRevision?.manifest;
			return data &&
				data.gadget.status === "active" &&
				manifest &&
				(manifest.navigation?.board || manifest.navigation?.work)
				? [{ gadget: data.gadget, manifest, role: workAppRole(manifest) }]
				: [];
		})
		.sort(
			(a, b) =>
				a.gadget.createdAt.localeCompare(b.gadget.createdAt) ||
				a.gadget.id.localeCompare(b.gadget.id),
		);
	return {
		apps,
		pending:
			workspaces.isPending ||
			lists.some((q) => q.isPending) ||
			details.some((q) => q.isPending),
		failed:
			workspaces.isError ||
			lists.some((q) => q.isError) ||
			details.some((q) => q.isError),
		truncated: Boolean(
			workspaces.data?.truncated || lists.some((q) => q.data?.truncated),
		),
		retry: () => {
			void workspaces.refetch();
			lists.forEach((q) => void q.refetch());
			details.forEach((q) => void q.refetch());
		},
	};
}
