"use client";

import { type LinkComponentProps, LinkProvider } from "@cloudflare/kumo/utils";
import {
	type AnyRouter,
	Link,
	type LinkComponentProps as TanStackLinkComponentProps,
} from "@tanstack/react-router";
import { forwardRef, type PropsWithChildren } from "react";

type OsRouterLinkProps = TanStackLinkComponentProps<
	"a",
	AnyRouter,
	string,
	string,
	string,
	string
>;

export const OsRouterLink = forwardRef<HTMLAnchorElement, OsRouterLinkProps>(
	({ activeOptions, ...props }, ref) => (
		<Link
			ref={ref}
			activeOptions={{ exact: true, ...activeOptions }}
			{...props}
		/>
	),
);
OsRouterLink.displayName = "OsRouterLink";

const KumoRouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, ...props }, ref) => {
		// Kumo Breadcrumbs accepts `href` publicly but currently forwards it to
		// LinkProvider as `to`. Normalize both until upstream removes `to`.
		const destination = href ?? to ?? "";
		if (
			destination.startsWith("#") ||
			/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)
		) {
			return <a ref={ref} href={destination} {...props} />;
		}

		return <OsRouterLink ref={ref} to={destination} {...props} />;
	},
);
KumoRouterLink.displayName = "KumoRouterLink";

export function KumoLinkProvider({ children }: PropsWithChildren) {
	return <LinkProvider component={KumoRouterLink}>{children}</LinkProvider>;
}
