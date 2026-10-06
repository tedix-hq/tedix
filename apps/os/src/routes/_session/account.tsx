import { createFileRoute, Outlet } from "@tanstack/react-router";

// First-class account surface (org picker + onboarding). It is a real `/account`
// segment nested under `_session` — a SIBLING of `_tenant`, so it never resolves
// a tenant or mounts `OsShell`, but a CHILD of the product `SessionBoundary`, so
// it inherits the exact broker resume/renewal timer and `OsIdentityContext` the
// launcher relied on while it was smuggled inside `_session/_tenant`. It mounts
// NO capability-lifecycle boundary of its own: capability lifecycle is a
// module-singleton owner, and reusing `_session`'s single boundary is what keeps
// a document from ever holding two.
export const Route = createFileRoute("/_session/account")({
	component: AccountLayout,
});

function AccountLayout() {
	return <Outlet />;
}
