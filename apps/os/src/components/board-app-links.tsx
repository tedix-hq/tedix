import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";
import { boardAppLink } from "@/lib/board-apps";

/** Discover only through the viewer's existing workspace and gadget access checks. */
export function BoardAppLinks() {
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const lists = useQueries({
		queries: (workspaces.data?.items ?? []).map((workspace) =>
			canvasGadgetsQueryOptions(workspace.id),
		),
	});
	const gadgets = lists.flatMap((list) => list.data?.items ?? []);
	const details = useQueries({
		queries: gadgets.map((gadget) =>
			canvasGadgetDetailQueryOptions(gadget.workspaceId, gadget.id),
		),
	});
	const links = details.flatMap((detail) => {
		const link =
			detail.data &&
			boardAppLink(detail.data.gadget, detail.data.currentRevision?.manifest);
		return link ? [link] : [];
	});
	const unavailable =
		workspaces.isError ||
		lists.some((list) => list.isError) ||
		details.some((detail) => detail.isError);
	const truncated =
		workspaces.data?.truncated || lists.some((list) => list.data?.truncated);
	return (
		<>
			{links.map((link) => (
				<Link
					key={link.id}
					href={link.href}
					variant="navigation"
					data-board-app={link.id}
				>
					{link.name}
				</Link>
			))}
			{unavailable && (
				<Text role="label" tone="secondary">
					Some workspace apps could not be loaded.
				</Text>
			)}
			{truncated && <Link href="/workspaces">More workspace apps</Link>}
		</>
	);
}
