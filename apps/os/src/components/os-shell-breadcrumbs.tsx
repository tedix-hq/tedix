import { matchOsPage } from "@/lib/os-navigation";
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
	return <RouteBreadcrumbs context={context} pathname={pathname} />;
}

function SkillBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(skillDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		skill: data?.entry?.title,
	});
	return <RouteBreadcrumbs context={context} pathname={pathname} />;
}

function AppBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(appDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		app: data?.app?.name,
	});
	return <RouteBreadcrumbs context={context} pathname={pathname} />;
}

export function OsShellBreadcrumbs({ pathname }: { pathname: string }) {
	const outputId = /^\/outputs\/([^/]+)/.exec(pathname)?.[1];
	if (outputId) return <OutputBreadcrumbs pathname={pathname} id={outputId} />;
	const skillId = /^\/skills\/([^/]+)/.exec(pathname)?.[1];
	if (skillId) return <SkillBreadcrumbs pathname={pathname} id={skillId} />;
	const appId = /^\/apps\/([^/]+)/.exec(pathname)?.[1];
	if (appId) return <AppBreadcrumbs pathname={pathname} id={appId} />;
	const context = resolveOsShellRouteContext(pathname);
	return <RouteBreadcrumbs context={context} pathname={pathname} />;
}

function RouteBreadcrumbs({
	context,
	pathname,
}: {
	context: ReturnType<typeof resolveOsShellRouteContext>;
	pathname: string;
}) {
	const page = matchOsPage(pathname)?.page;
	const labels = context.crumbs.map((crumb) => crumb.label);
	if (page?.breadcrumb === "parent") labels.push(page.label);
	useDocumentTitle(`${labels.join(" · ")} · Tedix`);
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}
