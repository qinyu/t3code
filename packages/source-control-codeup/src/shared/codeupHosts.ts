export const DEFAULT_WEB_HOST = "codeup.aliyun.com";
export const DEFAULT_API_BASE_URL = "https://openapi-rdc.aliyuncs.com";

export interface CodeupHostConfig {
  /** Lower-case web hostname used in git remotes and change-request URLs. */
  readonly webHost: string;
  /** OpenAPI origin, including scheme. */
  readonly apiBaseUrl: string;
  /** Required for central edition; empty for Region edition. */
  readonly organizationId: string | null;
}

const registeredHosts = new Map<string, CodeupHostConfig>();

export function normalizeWebHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/u, "");
}

export function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed === "") return DEFAULT_API_BASE_URL;
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

/** Built-in central edition, always recognized. */
export const DEFAULT_HOST_CONFIG: CodeupHostConfig = {
  webHost: DEFAULT_WEB_HOST,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  organizationId: null,
};

export function registerCodeupHost(config: CodeupHostConfig): void {
  const webHost = normalizeWebHost(config.webHost);
  if (webHost === "") return;
  registeredHosts.set(webHost, {
    webHost,
    apiBaseUrl: normalizeApiBaseUrl(config.apiBaseUrl),
    organizationId: config.organizationId?.trim() || null,
  });
}

export function clearRegisteredCodeupHosts(): void {
  registeredHosts.clear();
}

export function registeredCodeupHosts(): ReadonlyArray<CodeupHostConfig> {
  return [...registeredHosts.values()];
}

export function looksLikeCodeupHostname(hostname: string): boolean {
  const host = normalizeWebHost(hostname);
  return host === DEFAULT_WEB_HOST || host.split(".").includes("codeup");
}

export function codeupHostConfig(hostname: string): CodeupHostConfig | null {
  const host = normalizeWebHost(hostname);
  const registered = registeredHosts.get(host);
  if (registered) return registered;
  if (looksLikeCodeupHostname(host)) {
    return {
      webHost: host,
      apiBaseUrl: DEFAULT_API_BASE_URL,
      organizationId: registeredHosts.get(DEFAULT_WEB_HOST)?.organizationId ?? null,
    };
  }
  return null;
}

export function isCodeupHost(hostname: string): boolean {
  return codeupHostConfig(hostname) !== null;
}

/** Repository paths may include nested Codeup groups. */
const REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^(?:[^@/:]+@)?([^/:]+):(.+)$/u,
];

export function codeupRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  if (repository === "" || repository.includes("//") || repository.startsWith("/")) return null;
  const segments = repository.split("/").filter(Boolean);
  return segments.length >= 2 ? segments.join("/") : null;
}

export function parseCodeupRemote(
  url: string,
): { readonly host: string; readonly repository: string } | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (!match?.[1] || !match[2]) continue;
    const host = normalizeWebHost(match[1]);
    if (!isCodeupHost(host)) continue;
    const repository = codeupRepositoryPath(match[2]);
    return repository ? { host, repository } : null;
  }
  return null;
}

export function encodeRepositoryId(repository: string): string {
  return encodeURIComponent(repository);
}

/**
 * Central edition paths include the organization; Region edition omits it.
 * `organizationId` null/empty selects Region edition.
 */
export function codeupApiPath(input: {
  readonly organizationId: string | null | undefined;
  readonly suffix: string;
}): string {
  const org = input.organizationId?.trim();
  const suffix = input.suffix.startsWith("/") ? input.suffix : `/${input.suffix}`;
  return org
    ? `/oapi/v1/codeup/organizations/${encodeURIComponent(org)}${suffix}`
    : `/oapi/v1/codeup${suffix}`;
}
