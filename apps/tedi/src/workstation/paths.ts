export const WORKSTATION_HOME = "/home/tedi";
export const WORKSTATION_DIR = `${WORKSTATION_HOME}/workstation`;
export const WORKSTATION_REPOS_DIR = `${WORKSTATION_DIR}/repos`;

export const WORKSTATION_GIT_CREDENTIALS_PATH = `${WORKSTATION_HOME}/.git-credentials`;
export const WORKSTATION_GH_HOSTS_PATH = `${WORKSTATION_HOME}/.config/gh/hosts.yml`;

export function isWorkstationPath(path: string): boolean {
	return path === WORKSTATION_DIR || path.startsWith(`${WORKSTATION_DIR}/`);
}
