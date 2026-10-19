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
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}

function SkillBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(skillDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		skill: data?.entry?.title,
	});
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}

function AppBreadcrumbs({ pathname, id }: { pathname: string; id: string }) {
	const { data } = useQuery(appDetailQueryOptions(id));
	const context = resolveOsShellRouteContext(pathname, {
		app: data?.app?.name,
	});
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}

export function OsShellBreadcrumbs({ pathname }: { pathname: string }) {
	const outputId = /^\/outputs\/([^/]+)/.exec(pathname)?.[1];
	if (outputId) return <OutputBreadcrumbs pathname={pathname} id={outputId} />;
	const skillId = /^\/skills\/([^/]+)/.exec(pathname)?.[1];
	if (skillId) return <SkillBreadcrumbs pathname={pathname} id={skillId} />;
	const appId = /^\/apps\/([^/]+)/.exec(pathname)?.[1];
	if (appId) return <AppBreadcrumbs pathname={pathname} id={appId} />;
	const context = resolveOsShellRouteContext(pathname);
	return <Breadcrumbs items={context.crumbs} section={context.section} />;
}
