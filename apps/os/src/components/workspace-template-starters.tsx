import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsBlueprintGalleryItem } from "@tedix/api-contract/contracts/os-workspaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Link } from "@/components/kumo/link";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	BLUEPRINT_GALLERY_LIMIT,
	blueprintGalleryQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { SURFACE_ICONS } from "@/lib/surface-icons";

/** How many templates the empty workspace list offers. */
export const WORKSPACE_TEMPLATE_STARTERS = 3;

/** Featured templates first, then the rest in gallery order. */
export function pickTemplateStarters(
	items: readonly OsBlueprintGalleryItem[],
): OsBlueprintGalleryItem[] {
	return [
		...items.filter((item) => item.featured),
		...items.filter((item) => !item.featured),
	].slice(0, WORKSPACE_TEMPLATE_STARTERS);
}

/** The API answers CONFLICT when the workspace name is already in use. */
function isNameTaken(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "CONFLICT";
}

/**
 * Template cards for a person with no workspace yet. One click creates a
 * workspace named after the template and opens it. When the gallery is empty
 * or cannot load, nothing shows and the list keeps its plain empty state.
 */
export function WorkspaceTemplateStarters({
	onCreated,
}: {
	onCreated: (workspaceId: string) => void;
}) {
	const queryClient = useQueryClient();
	const gallery = useQuery({
		...blueprintGalleryQueryOptions(BLUEPRINT_GALLERY_LIMIT),
		retry: false,
	});
	const create = useMutation({
		mutationFn: (item: OsBlueprintGalleryItem) =>
			osApi.osWorkspaces.blueprints.instantiateFromGallery({
				blueprintId: item.id,
				workspaceName: item.name,
			}),
		onSuccess: ({ workspace }) => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.blueprints(),
			});
			onCreated(workspace.id);
		},
	});
	const starters = pickTemplateStarters(gallery.data?.items ?? []);
	if (starters.length === 0) return null;
	const TemplateIcon = SURFACE_ICONS.blueprints;

	return (
		<section
			aria-labelledby="workspace-template-starters"
			className="grid gap-3"
		>
			<div className="grid gap-0.5">
				<Text
					as="h2"
					id="workspace-template-starters"
					role="body"
					tone="strong"
					weight="medium"
					className="m-0"
				>
					Start from a template
				</Text>
				<Text role="label" tone="secondary" className="m-0">
					Each one creates a workspace with its apps already set up.
				</Text>
			</div>
			<ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
				{starters.map((item) => (
					<Surface
						as="li"
						key={item.id}
						tier="panel"
						className="flex min-w-0 flex-col gap-3 p-3"
					>
						<div className="flex min-w-0 items-start gap-3">
							<IconFrame aria-hidden size="sm">
								<TemplateIcon size={16} />
							</IconFrame>
							<div className="grid min-w-0 flex-1 gap-0.5">
								<Text
									as="strong"
									role="body"
									tone="strong"
									weight="medium"
									className="break-words [overflow-wrap:anywhere]"
								>
									{item.name}
								</Text>
								<Text as="span" role="label" tone="secondary">
									{item.gadgetCount === 1
										? "1 app"
										: `${item.gadgetCount} apps`}{" "}
									· by {item.organizationName}
								</Text>
								{item.description ? (
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="line-clamp-3 break-words [overflow-wrap:anywhere]"
									>
										{item.description}
									</Text>
								) : null}
							</div>
						</div>
						<Button
							aria-label={`Start a workspace from ${item.name}`}
							className="mt-auto w-full"
							disabled={create.isPending || create.isSuccess}
							onClick={() => create.mutate(item)}
							size="sm"
							variant="outline"
						>
							{create.isPending && create.variables.id === item.id
								? "Creating…"
								: "Use this template"}
						</Button>
					</Surface>
				))}
			</ul>
			{create.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn't create the workspace</AlertTitle>
					<AlertDescription className="break-words">
						{isNameTaken(create.error)
							? `A workspace named “${create.variables.name}” already exists.`
							: create.error.message}{" "}
						<Link
							href={`/blueprints?view=explore&install=${create.variables.id}`}
						>
							{isNameTaken(create.error)
								? "Pick another name"
								: "Check this template's setup"}
						</Link>
					</AlertDescription>
				</Alert>
			) : null}
		</section>
	);
}
