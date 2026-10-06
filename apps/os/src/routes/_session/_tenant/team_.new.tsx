import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import {
	CreateTediPage,
	type CreateTediChannel,
} from "@/components/create-tedi-page";
import { OsRouteError } from "@/components/os-route-boundaries";
import { prefetchCreateTediRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

const searchSchema = z.object({
	channel: z.enum(["none", "telegram", "webchat"]).catch("telegram"),
	mode: z.enum(["basic", "advanced"]).catch("basic"),
});

export const Route = createFileRoute("/_session/_tenant/team_/new")({
	validateSearch: searchSchema,
	loaderDeps: ({ search }) => search,
	loader: ({ context }) => prefetchCreateTediRoute(context.queryClient),
	component: CreateTediRoute,
	pendingComponent: DetailPending,
	errorComponent: OsRouteError,
});

function CreateTediRoute() {
	const { channel, mode } = Route.useSearch();
	const navigate = Route.useNavigate();
	const update = (patch: {
		channel?: CreateTediChannel;
		mode?: "basic" | "advanced";
	}) => void navigate({ search: (previous) => ({ ...previous, ...patch }) });

	return (
		<CreateTediPage
			channel={channel}
			advanced={mode === "advanced"}
			onChannelChange={(next) => update({ channel: next })}
			onAdvancedChange={(open) => update({ mode: open ? "advanced" : "basic" })}
		/>
	);
}
