import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_HOST,
  isCodeupHost,
  normalizeApiBaseUrl,
  normalizeWebHost,
  registerCodeupHost,
} from "./codeupHosts.ts";
import { icon } from "./icon.ts";

/** Nested Codeup groups: `/group/sub/repo/change/12`. */
const CHANGE_REQUEST_PATH = /^\/(.+)\/change\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/(.+)\/commit\/([0-9a-f]+)\/?$/iu;

const KIND = SourceControlProviderKind.make("codeup");

const text = (annotations: Schema.Annotations.Key<string>) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey(annotations),
  );

const secret = (annotations: Schema.Annotations.Key<SettingsSecretValue>) =>
  SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ ...annotations, providerSettingsForm: { control: "password" } }),
  );

export const settings = makeProviderSettingsSchema(
  {
    token: secret({
      title: "Personal access token",
      description:
        "A Yunxiao personal access token (`pt-…`), sent as `x-yunxiao-token`. Used before ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN.",
    }),
    organizationId: text({
      title: "Organization ID",
      description:
        "Required for central edition (codeup.aliyun.com). Leave empty for Region edition.",
      providerSettingsForm: { placeholder: "60d54f3daccf2bbd6659f3ad" },
    }),
    apiBaseUrl: text({
      title: "API base URL",
      description:
        "Central edition uses openapi-rdc.aliyuncs.com. Region edition uses the instance OpenAPI domain.",
      providerSettingsForm: { placeholder: DEFAULT_API_BASE_URL },
    }),
    webHost: text({
      title: "Web host",
      description:
        "Hostname of git remotes and merge-request links. Central edition uses codeup.aliyun.com.",
      providerSettingsForm: { placeholder: DEFAULT_WEB_HOST },
    }),
  },
  { order: ["token", "organizationId", "apiBaseUrl", "webHost"] },
);
export type CodeupSettings = typeof settings.Type;

/** Apply connection fields so Region hosts are recognized after Settings sync or server load. */
export function applyCodeupSettings(settingsValue: CodeupSettings): void {
  const webHost = normalizeWebHost(settingsValue.webHost || DEFAULT_WEB_HOST);
  registerCodeupHost({
    webHost,
    apiBaseUrl: normalizeApiBaseUrl(settingsValue.apiBaseUrl || DEFAULT_API_BASE_URL),
    organizationId: settingsValue.organizationId.trim() || null,
  });
}

function parseChangeRequestUrl(url: URL) {
  return isCodeupHost(url.hostname) ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH) : null;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Codeup",
  pickerLabel: "Codeup",
  icon,
  searchKeywords: ["yunxiao", "alibaba", "aliyun", "云效"],
  changeRequest: {
    shortLabel: "MR",
    shortLabelWithArticle: "an MR",
    singular: "merge request",
    plural: "merge requests",
  },
  repositoryPathHint: "group/repo",
  publicHost: DEFAULT_WEB_HOST,
  publishDescription: DEFAULT_WEB_HOST,
  publishHost: () => DEFAULT_WEB_HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `change/${number}`)
      : `https://${host}/${repository}/change/${number}`,
  parseChangeRequestUrl,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url) => (isCodeupHost(url.hostname) ? parseCommitPath(url, COMMIT_PATH) : null),
  changeRequestUrlFromReferenceAutolink: () => null,
  // UpdateChangeRequest only edits title/description; there is no WIP/draft endpoint yet.
  changeRequestActions: new Set(["merge", "close", "reopen"] as const),
  checkoutCommand: ({ headBranch }) =>
    headBranch ? `git fetch origin ${headBranch}` : `git fetch origin`,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => {
    try {
      return parseChangeRequestUrl(new URL(url)) !== null;
    } catch {
      return false;
    }
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname }) => {
    const host = normalizeWebHost(hostname);
    return isCodeupHost(host)
      ? {
          kind: KIND,
          name: host === DEFAULT_WEB_HOST ? "Codeup" : "Codeup Self-Hosted",
          baseUrl: `https://${host}`,
        }
      : null;
  },
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});

export function parsePullRequestUrl(value: string) {
  try {
    return parseChangeRequestUrl(new URL(value));
  } catch {
    return null;
  }
}

export function canonicalizePullRequestUrl(value: string): string {
  const link = parsePullRequestUrl(value);
  return link === null ? value : (definition.changeRequestUrl(link) ?? value);
}
