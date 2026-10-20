import { createFileRoute } from "@tanstack/react-router";
import { BrainPage } from "@/components/brain-page";
import { memorySearchSchema } from "@/lib/memory-browser";

export const Route = createFileRoute("/_session/_tenant/brain")({
	validateSearch: memorySearchSchema,
	component: BrainPage,
});
