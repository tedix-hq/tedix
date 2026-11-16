import { createFileRoute, redirect } from "@tanstack/react-router";

// The schedule now lives on the skill's Settings tab; old links land there.
export const Route = createFileRoute(
	"/_session/_tenant/skills/$skillId/schedule",
)({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/skills/$skillId/settings",
			params: { skillId: params.skillId },
			replace: true,
		});
	},
});
