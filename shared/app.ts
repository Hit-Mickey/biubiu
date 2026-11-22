export const appName = "BiuBiu";
const updateRepository = { owner: "Hit-Mickey", repo: "biubiu" };
export const repositoryIssuesUrl = `https://github.com/${updateRepository.owner}/${updateRepository.repo}/issues`;

export function formatAppVersion(version: string) {
  return version ? `v${version.replace(/^v/, "")}` : "";
}
