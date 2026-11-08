import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { codeupApiPath, encodeRepositoryId, isCodeupHost } from "../shared/codeupHosts.ts";

import * as CodeupCredentials from "./CodeupCredentials.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);

export const CodeupApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class CodeupApiError extends Schema.TaggedError<CodeupApiError>()("CodeupApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: CodeupApiFailure,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Codeup ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

export interface CodeupApiRequest {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
}

export class CodeupApi extends Context.Service<
  CodeupApi,
  {
    readonly request: (input: CodeupApiRequest) => Effect.Effect<string, CodeupApiError>;
    readonly repositoryPath: (input: {
      readonly host: string;
      readonly repository: string;
      readonly suffix?: string;
    }) => Effect.Effect<string, CodeupApiError>;
  }
>()("@t3tools/source-control-codeup/server/CodeupApi") {}

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errorMessage: Schema.optional(Schema.String),
      errorCode: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof CodeupApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

const MAX_PROBLEM_TEXT = 300;
const boundedProblemText = (text: string | undefined) => {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_PROBLEM_TEXT ? `${line.slice(0, MAX_PROBLEM_TEXT)}…` : line;
};

const credentialFailure = (
  error: CodeupCredentials.CodeupCredentialUnavailableError,
): typeof CodeupApiFailure.Type =>
  error._tag === "CodeupCredentialMissingError" || error._tag === "SettingsSecretUnresolvedError"
    ? "unauthenticated"
    : "failed";

function withQuery(
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* CodeupCredentials.CodeupCredentials;

  const request = Effect.fn("CodeupApi.request")(function* (input: CodeupApiRequest) {
    const fail = (
      fields: Pick<CodeupApiError, "status" | "reason" | "detail"> & { cause?: unknown },
    ) =>
      new CodeupApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });

    if (!isCodeupHost(input.host)) {
      return yield* fail({
        status: null,
        reason: "failed",
        detail: `${input.host} is not a registered Codeup host.`,
      });
    }

    yield* Effect.annotateCurrentSpan({
      "codeup.host": input.host,
      "codeup.operation": input.operation,
      "http.request.method": input.method ?? "GET",
    });

    const credential = yield* credentials
      .get(input.host)
      .pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: credentialFailure(cause), detail: cause.message, cause }),
        ),
      );

    const method = input.method ?? "GET";
    const url = withQuery(
      `${credential.apiBaseUrl.replace(/\/+$/u, "")}${input.path}`,
      input.query,
    );

    const base = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "t3code",
        "x-yunxiao-token": Redacted.value(credential.token),
      }),
    );

    const response = yield* httpClient
      .execute(
        input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
      )
      .pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        Effect.flatMap((res) => Effect.map(res.text, (text) => ({ status: res.status, text }))),
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail({ status: null, reason: "failed", detail: "Could not reach Codeup.", cause }),
        ),
      );

    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
    if (response.status >= 200 && response.status < 300) return response.text;

    const problem = Option.getOrUndefined(decodeProblem(response.text));
    return yield* fail({
      status: response.status,
      reason: reasonForStatus(response.status),
      detail:
        boundedProblemText(problem?.errorMessage ?? problem?.message ?? problem?.errorCode) ??
        `Codeup answered HTTP ${response.status}.`,
    });
  });

  return CodeupApi.of({
    request,
    repositoryPath: Effect.fn("CodeupApi.repositoryPath")(function* (input: {
      readonly host: string;
      readonly repository: string;
      readonly suffix?: string;
    }) {
      const credential = yield* credentials.get(input.host).pipe(
        Effect.mapError(
          (cause) =>
            new CodeupApiError({
              host: input.host,
              operation: "repositoryPath",
              status: null,
              reason: credentialFailure(cause),
              detail: cause.message,
              cause,
            }),
        ),
      );
      const suffix = `/repositories/${encodeRepositoryId(input.repository)}${input.suffix ?? ""}`;
      return codeupApiPath({ organizationId: credential.organizationId, suffix });
    }),
  });
});

export const layer = Layer.effect(CodeupApi, make);
