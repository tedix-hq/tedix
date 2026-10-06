import { createFileRoute } from "@tanstack/react-router";
import { ChatPage } from "@/components/chat-page";
import { validateChatSearch } from "@/lib/canvas-search";

export const Route = createFileRoute("/_session/_tenant/chat")({
	validateSearch: validateChatSearch,
	component: ChatPage,
});
