export const appName = "biubiu";
export const appId = "com.hitmickey.biubiu";
export const updateRepository = { owner: "Hit-Mickey", repo: "biubiu" };
export const repositoryIssuesUrl = `https://github.com/${updateRepository.owner}/${updateRepository.repo}/issues`;

export function formatAppVersion(version: string) {
  if (!version) return "";
  const release = version.replace(/^v/, "");
  return `v${release.replace(/^(\d+\.\d+)\.0$/, "$1")}`;
}
