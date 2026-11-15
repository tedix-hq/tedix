import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_WORK_SEARCH } from "@/shared/work-redirects";

export const Route = createFileRoute("/_session/_tenant/work/recovery")({
	beforeLoad: () => {
		throw redirect({
			to: "/work",
			search: LEGACY_WORK_SEARCH["/work/recovery"],
			replace: true,
		});
	},
});
