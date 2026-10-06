import { createContext } from "react";

export interface OsIdentity {
	name: string;
	email: string;
	avatarUrl?: string | null;
}

export const OsIdentityContext = createContext<OsIdentity | null>(null);
