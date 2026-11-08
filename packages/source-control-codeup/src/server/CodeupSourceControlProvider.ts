import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SourceControlApiDiscoverySpec } from "@t3tools/source-control-core/server/discovery";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  codeupApiPath,
  codeupRepositoryPath,
  DEFAULT_WEB_HOST,
  parseCodeupRemote,
} from "../shared/codeupHosts.ts";
import { parsePullRequestUrl } from "../shared/definition.ts";
import { mapChangeRequestState, mapIsDraft } from "./codeupChangeRequestJson.ts";
import * as CodeupApi from "./CodeupApi.ts";
import * as CodeupCredentials from "./CodeupCredentials.ts";

interface Target {
  readonly host: string;
  readonly repository: string;
}

const Repository = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  pathWithNamespace: Schema.optional(Schema.String),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
  httpUrlToRepo: Schema.optional(Schema.String),
  sshUrlToRepo: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
});

const ChangeRequestRow = Schema.Struct({
  localId: Schema.Number,
  title: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  workInProgress: Schema.optional(Schema.Boolean),
  webUrl: Schema.optional(Schema.String),
  detailUrl: Schema.optional(Schema.String),
  updateTime: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  mergedRevision: Schema.optional(Schema.NullOr(Schema.String)),
});

const ChangeRequestList = Schema.Union([
  Schema.Array(ChangeRequestRow),
  Schema.Struct({ items: Schema.Array(ChangeRequestRow) }),
  Schema.Struct({ result: Schema.Array(ChangeRequestRow) }),
]);

const Created = Schema.Struct({
  localId: Schema.Number,
});

function rowsOf(list: typeof ChangeRequestList.Type): ReadonlyArray<typeof ChangeRequestRow.Type> {
  if (Array.isArray(list)) return list;
  const record = list as {
    readonly items?: ReadonlyArray<typeof ChangeRequestRow.Type>;
    readonly result?: ReadonlyArray<typeof ChangeRequestRow.Type>;
  };
  return record.items ?? record.result ?? [];
}

function toChangeRequest(
  host: string,
  repository: string,
  row: typeof ChangeRequestRow.Type,
): ChangeRequest {
  const number = row.localId;
  return {
    provider: SourceControlProviderKind.make("codeup"),
    number,
    title: row.title,
    url: row.webUrl ?? row.detailUrl ?? `https://${host}/${repository}/change/${number}`,
    baseRefName: row.targetBranch,
    headRefName: row.sourceBranch,
    ...(row.mergedRevision ? { headSha: row.mergedRevision } : {}),
    state: mapChangeRequestState(row.status),
    ...(mapIsDraft({
      status: row.status,
      ...(row.workInProgress === undefined ? {} : { workInProgress: row.workInProgress }),
    })
      ? { isDraft: true }
      : {}),
    updatedAt: row.updateTime ?? row.updatedAt ?? Option.none(),
  };
}

export const make = Effect.gen(function* () {
  const api = yield* CodeupApi.CodeupApi;
  const credentials = yield* CodeupCredentials.CodeupCredentials;
  const hostService = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: SourceControlProviderKind.make("codeup"),
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const readJson = <A, I>(
    operation: string,
    cwd: string,
    request: Omit<CodeupApi.CodeupApiRequest, "operation">,
    schema: Schema.Codec<A, I>,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "Codeup returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const resolveTarget = Effect.fn("CodeupSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    if (input.repository) {
      const named = parseCodeupRemote(input.repository);
      if (named) return named;
      const path = codeupRepositoryPath(input.repository);
      if (path) {
        return {
          host: parseCodeupRemote(input.context?.remoteUrl ?? "")?.host ?? DEFAULT_WEB_HOST,
          repository: path,
        } satisfies Target;
      }
    }
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* hostService.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) =>
          hostService.git.readConfigValue(input.cwd, `remote.${remote}.url`),
        ),
        Effect.mapError((cause) =>
          error(operation, input.cwd, "Could not read the Codeup remote.", cause),
        ),
      ));
    if (remoteUrl === null) {
      return yield* error(operation, input.cwd, "No Codeup repository remote was found.");
    }
    const remote = parseCodeupRemote(remoteUrl);
    if (remote) return remote;
    return yield* error(operation, input.cwd, "No Codeup repository remote was found.");
  });

  const getChangeRequest = Effect.fn("CodeupSourceControlProvider.getChangeRequest")(
    function* (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) {
      const match = parsePullRequestUrl(input.reference.trim());
      const numberMatch = /^#?([1-9]\d*)$/u.exec(input.reference.trim());
      const target =
        match !== null
          ? { host: match.host, repository: match.repository }
          : yield* resolveTarget("getChangeRequest", input);
      const number = match?.number ?? (numberMatch ? Number(numberMatch[1]) : undefined);
      if (number === undefined) {
        return yield* error(
          "getChangeRequest",
          input.cwd,
          "A Codeup merge request is a number or a Codeup change URL.",
        );
      }
      const path = yield* api
        .repositoryPath({
          host: target.host,
          repository: target.repository,
          suffix: `/changeRequests/${number}`,
        })
        .pipe(
          Effect.mapError((cause) => error("getChangeRequest", input.cwd, cause.detail, cause)),
        );
      const row = yield* readJson(
        "getChangeRequest",
        input.cwd,
        { host: target.host, path },
        ChangeRequestRow,
      );
      return toChangeRequest(target.host, target.repository, row);
    },
  );

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("codeup"),
    repositoryNameFromRemoteUrl: (url) => parseCodeupRemote(url)?.repository ?? null,
    listChangeRequests: Effect.fn("CodeupSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const credential = yield* credentials
          .get(target.host)
          .pipe(
            Effect.mapError((cause) =>
              error("listChangeRequests", input.cwd, cause.message, cause),
            ),
          );
        const branch = SourceControlProvider.sourceBranch(input);
        const list = yield* readJson(
          "listChangeRequests",
          input.cwd,
          {
            host: target.host,
            path: codeupApiPath({
              organizationId: credential.organizationId,
              suffix: "/changeRequests",
            }),
            query: {
              projectIds: target.repository,
              state:
                input.state === "open" ? "opened" : input.state === "all" ? undefined : input.state,
              perPage: input.limit ?? 20,
            },
          },
          ChangeRequestList,
        );
        return rowsOf(list)
          .filter((row) => row.sourceBranch === branch)
          .filter((row) =>
            input.state === "all" ? true : mapChangeRequestState(row.status) === input.state,
          )
          .slice(0, input.limit ?? 20)
          .map((row) => toChangeRequest(target.host, target.repository, row));
      },
    ),
    getChangeRequest,
    createChangeRequest: Effect.fn("CodeupSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const description = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the merge request body.",
                cause,
              ),
            ),
          );
        const repositoryPath = yield* api
          .repositoryPath({ host: target.host, repository: target.repository })
          .pipe(
            Effect.mapError((cause) =>
              error("createChangeRequest", input.cwd, cause.detail, cause),
            ),
          );
        const repository = yield* readJson(
          "createChangeRequest",
          input.cwd,
          { host: target.host, path: repositoryPath },
          Repository,
        );
        if (repository.id === undefined) {
          return yield* error(
            "createChangeRequest",
            input.cwd,
            "Codeup did not return a repository id.",
          );
        }
        const numericId = typeof repository.id === "number" ? repository.id : Number(repository.id);
        const createPath = yield* api
          .repositoryPath({
            host: target.host,
            repository: target.repository,
            suffix: "/changeRequests",
          })
          .pipe(
            Effect.mapError((cause) =>
              error("createChangeRequest", input.cwd, cause.detail, cause),
            ),
          );
        yield* readJson(
          "createChangeRequest",
          input.cwd,
          {
            host: target.host,
            method: "POST",
            path: createPath,
            body: {
              sourceBranch: SourceControlProvider.sourceBranch(input),
              targetBranch: input.baseRefName,
              sourceProjectId: numericId,
              targetProjectId: numericId,
              title: input.title,
              description,
            },
          },
          Created,
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("CodeupSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        const path = yield* api
          .repositoryPath({ host: target.host, repository: target.repository })
          .pipe(
            Effect.mapError((cause) =>
              error("getRepositoryCloneUrls", input.cwd, cause.detail, cause),
            ),
          );
        const repository = yield* readJson(
          "getRepositoryCloneUrls",
          input.cwd,
          { host: target.host, path },
          Repository,
        );
        return {
          nameWithOwner: target.repository,
          url:
            repository.httpUrlToRepo ??
            repository.webUrl ??
            `https://${target.host}/${target.repository}.git`,
          sshUrl: repository.sshUrlToRepo ?? `git@${target.host}:${target.repository}.git`,
        } satisfies SourceControlRepositoryCloneUrls;
      },
    ),
    createRepository: Effect.fn("CodeupSourceControlProvider.createRepository")(function* (input) {
      const path = codeupRepositoryPath(input.repository);
      if (path === null) {
        return yield* error(
          "createRepository",
          input.cwd,
          "A Codeup repository is named group/repo.",
        );
      }
      const segments = path.split("/");
      const name = segments.at(-1)!;
      const credential = yield* credentials
        .get(DEFAULT_WEB_HOST)
        .pipe(
          Effect.mapError((cause) => error("createRepository", input.cwd, cause.message, cause)),
        );
      const created = yield* readJson(
        "createRepository",
        input.cwd,
        {
          host: DEFAULT_WEB_HOST,
          method: "POST",
          path: codeupApiPath({
            organizationId: credential.organizationId,
            suffix: "/repositories",
          }),
          body: {
            name,
            path: name,
            visibility: input.visibility === "public" ? "internal" : "private",
            namespacePath: segments.slice(0, -1).join("/"),
          },
        },
        Repository,
      );
      return {
        nameWithOwner: created.pathWithNamespace ?? path,
        url: created.httpUrlToRepo ?? `https://${DEFAULT_WEB_HOST}/${path}.git`,
        sshUrl: created.sshUrlToRepo ?? `git@${DEFAULT_WEB_HOST}:${path}.git`,
      } satisfies SourceControlRepositoryCloneUrls;
    }),
    getDefaultBranch: Effect.fn("CodeupSourceControlProvider.getDefaultBranch")(function* (input) {
      const target = yield* resolveTarget("getDefaultBranch", input);
      const path = yield* api
        .repositoryPath({ host: target.host, repository: target.repository })
        .pipe(
          Effect.mapError((cause) => error("getDefaultBranch", input.cwd, cause.detail, cause)),
        );
      const repository = yield* readJson(
        "getDefaultBranch",
        input.cwd,
        { host: target.host, path },
        Repository,
      );
      return repository.defaultBranch?.trim() || "master";
    }),
    checkoutChangeRequest: Effect.fn("CodeupSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getChangeRequest(input);
        const sourceRepository =
          pull.headRepositoryNameWithOwner ??
          parseCodeupRemote(
            new URL(pull.url).origin + new URL(pull.url).pathname.replace(/\/change\/\d+.*$/u, ""),
          )?.repository ??
          parsePullRequestUrl(pull.url)?.repository;
        if (!sourceRepository) {
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "Codeup did not name the merge request's source repository.",
          );
        }
        const pullHost = new URL(pull.url).host;
        const contextRemote = input.context ? parseCodeupRemote(input.context.remoteUrl) : null;
        const git = hostService.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context &&
            contextRemote?.repository === sourceRepository &&
            contextRemote.host === pullHost
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "codeup",
                  url: isSshRemoteUrl(input.context?.remoteUrl ?? "")
                    ? `git@${pullHost}:${sourceRepository}.git`
                    : `https://${pullHost}/${sourceRepository}.git`,
                });
          const localBranch = pull.headRefName;
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = {
            cwd: input.cwd,
            remoteName,
            remoteBranch: pull.headRefName,
          };
          if (input.force !== true && !branches.includes(localBranch)) {
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          } else {
            yield* git.fetchRemoteTrackingBranch(remoteBranch);
          }
          if (input.force === true) {
            yield* git.execute({
              operation: "CodeupSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "--no-track",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${pull.headRefName}`,
                "--",
              ],
            });
          }
          yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out the Codeup merge request.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const credentials = yield* CodeupCredentials.CodeupCredentials;

  return {
    type: "api",
    kind: SourceControlProviderKind.make("codeup"),
    label: "Codeup",
    installHint:
      "Add a Yunxiao personal access token in Settings → Source control, or set ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN.",
    probeAuth: credentials.get(DEFAULT_WEB_HOST).pipe(
      Effect.map((credential): SourceControlProviderAuth =>
        providerAuth({
          status: "authenticated",
          host: credential.webHost,
          account: credential.organizationId ?? "codeup",
        }),
      ),
      Effect.orElseSucceed((): SourceControlProviderAuth =>
        providerAuth({
          status: "unauthenticated",
          host: DEFAULT_WEB_HOST,
          detail:
            "Save a Yunxiao personal access token in Settings → Source control, or set ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN.",
        }),
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});
