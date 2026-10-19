import { useDocumentTitle } from "@/lib/use-document-title";
import { useQuery } from "@tanstack/react-query";
import { Breadcrumbs } from "@/components/kumo/breadcrumbs";
import { resolveOsShellRouteContext } from "@/lib/os-shell-navigation";
import {
	appDetailQueryOptions,
	outputDetailQueryOptions,
	skillDetailQueryOptions,
} from "@/lib/os-query-options";

function OutputBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(outputDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		output: data?.output.title,
	});
	return <RouteBreadcrumbs context={context} />;
}

function SkillBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(skillDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		skill: data?.entry?.title,
	});
	return <RouteBreadcrumbs context={context} />;
}

function AppBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(appDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		app: data?.app?.name,
	});
	return <RouteBreadcrumbs context={context} />;
}

export function OsShellBreadcrumbs({ pathname }: { pathname: string }) {
	const outputId = /^\/outputs\/([^/]+)/.exec(pathname)?.[1];
	if (outputId) return <OutputBreadcrumbs pathname={pathname} id={outputId} />;
	const skillId = /^\/skills\/([^/]+)/.exec(pathname)?.[1];
	if (skillId) return <SkillBreadcrumbs pathname={pathname} id={skillId} />;
	const appId = /^\/apps\/([^/]+)/.exec(pathname)?.[1];
	if (appId) return <AppBreadcrumbs pathname={pathname} id={appId} />;
	const context = resolveOsShellRouteContext(pathname);
	return <RouteBreadcrumbs context={context} />;
}

function RouteBreadcrumbs({
	context,
}: {
	context: ReturnType<typeof resolveOsShellRouteContext>;
}) {
	useDocumentTitle(
		`${context.crumbs.map((crumb) => crumb.label).join(" · ")} · Tedix`,
	);
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}
