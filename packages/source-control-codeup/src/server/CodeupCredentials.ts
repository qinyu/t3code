import {
  requireSettingsSecretLiteral,
  type SettingsSecretUnresolvedError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import {
  applyCodeupSettings,
  definition,
  settings as codeupSettingsSchema,
  type CodeupSettings,
} from "../shared/definition.ts";
import {
  codeupHostConfig,
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_HOST,
  normalizeApiBaseUrl,
  normalizeWebHost,
} from "../shared/codeupHosts.ts";

export interface CodeupCredential {
  readonly webHost: string;
  readonly apiBaseUrl: string;
  readonly organizationId: string | null;
  readonly token: Redacted.Redacted<string>;
  readonly source: "settings" | "env";
}

export class CodeupCredentialMissingError extends Schema.TaggedError<CodeupCredentialMissingError>()(
  "CodeupCredentialMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Codeup credential for ${this.host}: save a personal access token in Settings → Source control, or set ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN.`;
  }
}

export type CodeupCredentialUnavailableError =
  | CodeupCredentialMissingError
  | SettingsSecretUnresolvedError;

export class CodeupCredentials extends Context.Service<
  CodeupCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<CodeupCredential, CodeupCredentialUnavailableError>;
  }
>()("@t3tools/source-control-codeup/server/CodeupCredentials") {}

export function environmentConnection(env: Readonly<Record<string, string | undefined>>): {
  readonly token: string | null;
  readonly organizationId: string | null;
  readonly apiBaseUrl: string;
  readonly webHost: string;
} {
  return {
    token: env.ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN?.trim() || null,
    organizationId: env.ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID?.trim() || null,
    apiBaseUrl: normalizeApiBaseUrl(env.ALIBABA_CLOUD_YUNXIAO_API_BASE_URL ?? DEFAULT_API_BASE_URL),
    webHost: normalizeWebHost(env.ALIBABA_CLOUD_YUNXIAO_WEB_HOST ?? DEFAULT_WEB_HOST),
  };
}

function emptySettings(): CodeupSettings {
  return { token: "", organizationId: "", apiBaseUrl: "", webHost: "" };
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const environment = yield* HostProcess.Environment;

  const readSettings = (): Effect.Effect<CodeupSettings, SettingsSecretUnresolvedError> =>
    sourceControlHost.settings.getWithSecrets(definition.kind).pipe(
      Effect.map((bundle) => {
        const settings = readSourceControlHostSettings(
          codeupSettingsSchema,
          bundle.sourceControlHosts[definition.kind],
        );
        applyCodeupSettings(settings);
        return { settings, secretProviders: bundle.secretProviders };
      }),
      Effect.orElseSucceed(() => ({ settings: emptySettings(), secretProviders: {} })),
      Effect.flatMap(({ settings, secretProviders }) =>
        requireSettingsSecretLiteral(settings.token, secretProviders).pipe(
          Effect.map((token) => ({
            ...settings,
            token,
          })),
        ),
      ),
    );

  return CodeupCredentials.of({
    get: Effect.fn("CodeupCredentials.get")(function* (host: string) {
      const webHost = normalizeWebHost(host);
      const settings = yield* readSettings();
      const fromEnv = environmentConnection(environment);
      const settingsHost = normalizeWebHost(settings.webHost || DEFAULT_WEB_HOST);
      const settingsToken = typeof settings.token === "string" ? settings.token.trim() : "";
      const known = codeupHostConfig(webHost);

      const apiBaseUrl =
        webHost === settingsHost
          ? normalizeApiBaseUrl(settings.apiBaseUrl || DEFAULT_API_BASE_URL)
          : webHost === fromEnv.webHost
            ? fromEnv.apiBaseUrl
            : (known?.apiBaseUrl ?? DEFAULT_API_BASE_URL);

      const organizationId =
        webHost === settingsHost
          ? settings.organizationId.trim() || null
          : webHost === fromEnv.webHost
            ? fromEnv.organizationId
            : (known?.organizationId ??
              (settings.organizationId.trim() || fromEnv.organizationId || null));

      if (settingsToken !== "") {
        return {
          webHost,
          apiBaseUrl,
          organizationId,
          token: Redacted.make(settingsToken),
          source: "settings" as const,
        };
      }
      if (fromEnv.token !== null) {
        return {
          webHost,
          apiBaseUrl: webHost === fromEnv.webHost ? fromEnv.apiBaseUrl : apiBaseUrl,
          organizationId: webHost === fromEnv.webHost ? fromEnv.organizationId : organizationId,
          token: Redacted.make(fromEnv.token),
          source: "env" as const,
        };
      }
      return yield* new CodeupCredentialMissingError({ host: webHost });
    }),
  });
});

export const layer = Layer.effect(CodeupCredentials, make);
