import { createFileRoute } from "@tanstack/react-router";
import { GuestAppPage } from "@/components/guest-app-page";

/** A share-link guest's app: outside every session layout, no login prompt. */
export const Route = createFileRoute("/guest")({
	component: GuestAppPage,
});
