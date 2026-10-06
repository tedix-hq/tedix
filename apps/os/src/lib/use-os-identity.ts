import { resolveOsTenant } from "@/shared/os-tenant";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { OsIdentityContext, type OsIdentity } from "./os-identity-context";
import { userProfileQueryOptions } from "./os-query-options";

export type { OsIdentity } from "./os-identity-context";

const LOCAL_IDENTITY: OsIdentity = {
	name: "Local Owner",
	email: "owner@localhost.invalid",
};

function useLocalIdentity(): OsIdentity {
	return LOCAL_IDENTITY;
}

function useBrokerIdentity(): OsIdentity {
	const brokerIdentity = useContext(OsIdentityContext) ?? {
		name: "Tedix member",
		email: "",
	};
	const profile = useQuery(userProfileQueryOptions());
	if (!profile.data) return brokerIdentity;
	return {
		name: profile.data.name ?? brokerIdentity.name,
		email: profile.data.email,
		avatarUrl: profile.data.avatarUrl,
	};
}

/**
 * Descope's useUser throws outside <AuthProvider/>, and the zero-account
 * local lane deliberately mounts none. The lane is constant for the app's
 * lifetime (it is derived from the hostname), so the hook implementation is
 * chosen once at module load — rules-of-hooks safe.
 */
export const useOsIdentity: () => OsIdentity =
	resolveOsTenant(window.location.hostname).kind === "local"
		? useLocalIdentity
		: useBrokerIdentity;
