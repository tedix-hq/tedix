import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_WORK_SEARCH } from "@/shared/work-redirects";

export const Route = createFileRoute("/_session/_tenant/work/portfolio")({
	beforeLoad: () => {
		throw redirect({
			to: "/work",
			search: LEGACY_WORK_SEARCH["/work/portfolio"],
			replace: true,
		});
	},
});
