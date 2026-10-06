import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "@/components/profile-page";
import { useDocumentTitle } from "@/lib/use-document-title";

export const Route = createFileRoute("/_session/account/profile")({
	component: AccountProfileRoute,
});

function AccountProfileRoute() {
	useDocumentTitle("Your profile · Tedix OS");
	return <ProfilePage />;
}
