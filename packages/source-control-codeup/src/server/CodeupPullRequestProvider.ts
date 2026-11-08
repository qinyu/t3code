import {
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestSummary,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { codeupApiPath, DEFAULT_WEB_HOST, isCodeupHost } from "../shared/codeupHosts.ts";
import { definition } from "../shared/definition.ts";

import * as CodeupApi from "./CodeupApi.ts";
import * as CodeupCredentials from "./CodeupCredentials.ts";
import {
  CodeupChangeRequestDetail,
  CodeupCiCheckList,
  CodeupCommentList,
  CodeupCompare,
  CodeupPatchSetList,
  commentsOf,
  comparePatch,
  latestSourcePatchSet,
  mapActor,
  mapChangeRequestState,
  mapChecksState,
  mapCiCheck,
  mapComment,
  mapCommits,
  mapIsDraft,
  mapMergeability,
  mapMergeType,
  mapReviewDecision,
  mapReviewThreads,
  mapReviewVerdict,
  patchSetBizId,
  patchSetsOf,
} from "./codeupChangeRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: false, listCandidates: false, searchCandidates: false },
  edit: { changeRequest: true, comment: false },
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Codeup needs a Yunxiao personal access token. Save one in Settings → Source control, or set ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN.",
  unauthenticated:
    "Codeup rejected the configured credentials. Check the token in Settings → Source control.",
};

export function codeupViewerPermissions(): PullRequestViewerPermissions {
  return {
    actions: [...CAPABILITIES.actions],
    comment: true,
    resolve: false,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: false,
  };
}

export function codeupProviderFailure(error: CodeupApi.CodeupApiError): PullRequestProviderFailure {
  return {
    reason: error.reason === "missing-tool" ? "failed" : error.reason,
  };
}

type PullRef = ProviderRepositoryRef & { readonly number: number };

function toChangeRequest(
  host: string,
  repository: string,
  row: typeof CodeupChangeRequestDetail.Type,
): ProviderChangeRequest {
  const number = row.localId;
  const url = row.webUrl ?? row.detailUrl ?? `https://${host}/${repository}/change/${number}`;
  const createdAt = row.createTime ?? row.createdAt ?? "1970-01-01T00:00:00.000Z";
  const updatedAt = row.updateTime ?? row.updatedAt ?? createdAt;
  return {
    number,
    title: row.title,
    url,
    author: mapActor(row.author),
    headBranch: row.sourceBranch,
    baseBranch: row.targetBranch,
    state: mapChangeRequestState(row.status),
    isDraft: mapIsDraft({
      status: row.status,
      ...(row.workInProgress === undefined ? {} : { workInProgress: row.workInProgress }),
    }),
    mergeability: mapMergeability({
      status: row.status,
      ...(row.conflictCheckStatus === undefined
        ? {}
        : { conflictCheckStatus: row.conflictCheckStatus }),
      ...(row.allRequirementsPass === undefined
        ? {}
        : { allRequirementsPass: row.allRequirementsPass }),
    }),
    additions: 0,
    deletions: 0,
    createdAt,
    updatedAt,
    reviewRequestLogins: (row.reviewers ?? [])
      .map((reviewer) => reviewer.username?.trim() || reviewer.name?.trim() || "")
      .filter(Boolean),
    labels: [],
    reviewDecision: mapReviewDecision(row.reviewers),
  };
}

function toSummary(
  host: string,
  repository: string,
  row: typeof CodeupChangeRequestDetail.Type,
): ProviderChangeRequestSummary {
  const change = toChangeRequest(host, repository, row);
  return {
    number: change.number,
    title: change.title,
    url: change.url,
    author: change.author,
    headBranch: change.headBranch,
    baseBranch: change.baseBranch,
    state: change.state,
    isDraft: change.isDraft,
    updatedAt: change.updatedAt,
    ...(row.mergedRevision ? { headSha: row.mergedRevision } : {}),
    reviewDecision: change.reviewDecision,
    mergeability: change.mergeability,
  };
}

function changeRequestRows(
  list:
    | ReadonlyArray<typeof CodeupChangeRequestDetail.Type>
    | { readonly items: ReadonlyArray<typeof CodeupChangeRequestDetail.Type> }
    | { readonly result: ReadonlyArray<typeof CodeupChangeRequestDetail.Type> },
): ReadonlyArray<typeof CodeupChangeRequestDetail.Type> {
  if (Array.isArray(list)) return list;
  const record = list as {
    readonly items?: ReadonlyArray<typeof CodeupChangeRequestDetail.Type>;
    readonly result?: ReadonlyArray<typeof CodeupChangeRequestDetail.Type>;
  };
  return record.items ?? record.result ?? [];
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* CodeupApi.CodeupApi;
  const credentials = yield* CodeupCredentials.CodeupCredentials;

  const fail = (operation: string) => (error: CodeupApi.CodeupApiError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("codeup"),
      operation,
      ...codeupProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const readJson = <A, I>(
    operation: string,
    request: Omit<CodeupApi.CodeupApiRequest, "operation">,
    schema: Schema.Codec<A, I>,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError(fail(operation)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: SourceControlProviderKind.make("codeup"),
                operation,
                reason: "failed",
                detail: "Codeup returned an unreadable response.",
                cause,
              }),
          ),
        ),
      ),
    );

  const changeRequestPath = (input: PullRef, suffix = "") =>
    api
      .repositoryPath({
        host: input.host,
        repository: input.repository,
        suffix: `/changeRequests/${input.number}${suffix}`,
      })
      .pipe(Effect.mapError(fail("repositoryPath")));

  const getDetail = (input: PullRef) =>
    changeRequestPath(input).pipe(
      Effect.flatMap((path) =>
        readJson("getChangeRequest", { host: input.host, path }, CodeupChangeRequestDetail),
      ),
    );

  const listComments = (input: PullRef) =>
    changeRequestPath(input, "/comments/list").pipe(
      Effect.flatMap((path) =>
        readJson(
          "listComments",
          { host: input.host, method: "POST", path, body: {} },
          CodeupCommentList,
        ),
      ),
      Effect.map(commentsOf),
    );

  const listPatchSets = (input: PullRef) =>
    changeRequestPath(input, "/diffs/patches").pipe(
      Effect.flatMap((path) =>
        readJson("listPatchSets", { host: input.host, path }, CodeupPatchSetList),
      ),
      Effect.map(patchSetsOf),
    );

  const getCompare = (input: PullRef, detail: typeof CodeupChangeRequestDetail.Type) =>
    api
      .repositoryPath({
        host: input.host,
        repository: input.repository,
        suffix: "/compares",
      })
      .pipe(
        Effect.mapError(fail("getDiff")),
        Effect.flatMap((path) =>
          readJson(
            "getDiff",
            {
              host: input.host,
              path,
              // Codeup's from/to follow git CLI order, opposite the merge-request UI.
              query: {
                from: detail.targetBranch,
                to: detail.sourceBranch,
                sourceType: "branch",
                targetType: "branch",
              },
            },
            CodeupCompare,
          ),
        ),
      );

  const listChecks = (input: PullRef) =>
    listPatchSets(input).pipe(
      Effect.flatMap((patchSets) => {
        const patch = latestSourcePatchSet(patchSets);
        const bizId = patch ? patchSetBizId(patch) : null;
        if (bizId === null) return Effect.succeed([]);
        return changeRequestPath(input, "/ciCheckList").pipe(
          Effect.flatMap((path) =>
            readJson(
              "getChangeRequestChecks",
              { host: input.host, path, query: { patchSetBizId: bizId } },
              CodeupCiCheckList,
            ),
          ),
          Effect.map((list) => [
            ...(list.checkList ?? []).map(mapCiCheck),
            ...(list.commitStatuses ?? []).map(mapCiCheck),
          ]),
        );
      }),
    );

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("codeup"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    servesHost: (host) => isCodeupHost(host),
    readsPublicHostWithoutCheckout: true,

    getViewer: (input) =>
      credentials.get(input.host ?? DEFAULT_WEB_HOST).pipe(
        Effect.map((credential) => credential.organizationId ?? "codeup"),
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: SourceControlProviderKind.make("codeup"),
              operation: "getViewer",
              reason: "unauthenticated",
              detail: cause.message,
              cause,
            }),
        ),
      ),

    listChangeRequests: (input) =>
      credentials.get(input.host).pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: SourceControlProviderKind.make("codeup"),
              operation: "listChangeRequests",
              reason: "unauthenticated",
              detail: cause.message,
              cause,
            }),
        ),
        Effect.flatMap((credential) =>
          readJson(
            "listChangeRequests",
            {
              host: input.host,
              path: codeupApiPath({
                organizationId: credential.organizationId,
                suffix: "/changeRequests",
              }),
              query: {
                projectIds: input.repository,
                state:
                  input.state === "open"
                    ? "opened"
                    : input.state === "all"
                      ? undefined
                      : input.state,
                search: input.query,
                perPage: input.limit,
              },
            },
            Schema.Union([
              Schema.Array(CodeupChangeRequestDetail),
              Schema.Struct({ items: Schema.Array(CodeupChangeRequestDetail) }),
              Schema.Struct({ result: Schema.Array(CodeupChangeRequestDetail) }),
            ]),
          ),
        ),
        Effect.map((list) => {
          const rows = changeRequestRows(list);
          return {
            items: rows.map((row) => toChangeRequest(input.host, input.repository, row)),
            truncated: rows.length >= input.limit,
            continues: false,
          };
        }),
      ),

    getChangeRequestChecks: (input) =>
      Effect.all([getDetail(input), listChecks(input)], { concurrency: 2 }).pipe(
        Effect.map(([detail, checks]) => ({
          state: mapChangeRequestState(detail.status),
          checks,
        })),
      ),

    getChangeRequest: (input) =>
      Effect.all([getDetail(input), listChecks(input)], { concurrency: 2 }).pipe(
        Effect.map(([detail, checks]): ProviderChangeRequestDetail => {
          const change = toChangeRequest(input.host, input.repository, detail);
          return {
            ...change,
            body: detail.description ?? "",
            changedFiles: 0,
            ...(detail.mergedRevision ? { headSha: detail.mergedRevision } : {}),
            mergedAt: change.state === "merged" ? change.updatedAt : null,
            closedAt: change.state === "closed" ? change.updatedAt : null,
            reviewers: (detail.reviewers ?? []).flatMap((reviewer) => {
              const actor = mapActor(reviewer);
              return actor ? [actor] : [];
            }),
            checks,
            checksState: mapChecksState(checks),
            mergeCapabilities: {
              merge: true,
              squash: detail.supportMergeFastForwardOnly !== true,
              rebase: detail.supportMergeFastForwardOnly !== true,
            },
            viewerPermissions: codeupViewerPermissions(),
            ...(detail.behind === undefined ? {} : { behindBy: detail.behind }),
          };
        }),
      ),

    getChangeRequestActivity: (input) =>
      getDetail(input).pipe(
        Effect.flatMap((detail) =>
          Effect.all([listComments(input), getCompare(input, detail)], { concurrency: 2 }).pipe(
            Effect.map(([comments, compare]): ProviderChangeRequestActivity => {
              const url =
                detail.webUrl ??
                detail.detailUrl ??
                `https://${input.host}/${input.repository}/change/${input.number}`;
              const mapped = comments.map((comment) => mapComment(comment, url));
              return {
                comments: mapped,
                commentCount: detail.totalCommentCount ?? mapped.length,
                commentsTruncated: false,
                reviewThreads: mapReviewThreads(comments),
                commits: mapCommits(compare),
              };
            }),
          ),
        ),
      ),

    getViewerPermissions: () => Effect.succeed(codeupViewerPermissions()),

    getDiff: (input) =>
      getDetail(input).pipe(
        Effect.flatMap((detail) => getCompare(input, detail)),
        Effect.map((compare) => ({
          patch: comparePatch(compare),
          truncated: false,
          nextCursor: null,
        })),
      ),

    runAction: (input) => {
      const actionPath =
        input.action === "merge"
          ? "/merge"
          : input.action === "close"
            ? "/close"
            : input.action === "reopen"
              ? "/reopen"
              : null;
      if (actionPath === null) {
        return Effect.fail(
          new PullRequestProviderError({
            provider: SourceControlProviderKind.make("codeup"),
            operation: "runAction",
            reason: "failed",
            detail: `Codeup does not support the ${input.action} action.`,
          }),
        );
      }
      return Effect.gen(function* () {
        const detail = input.action === "merge" ? yield* getDetail(input) : undefined;
        const path = yield* changeRequestPath(input, actionPath);
        yield* api
          .request({
            host: input.host,
            operation: "runAction",
            method: "POST",
            path,
            ...(input.action === "merge"
              ? {
                  body: {
                    mergeType: mapMergeType(input.mergeMethod, detail?.supportMergeFastForwardOnly),
                  },
                }
              : {}),
          })
          .pipe(Effect.mapError(fail("runAction")));
        const refreshed = yield* getDetail(input);
        return toSummary(input.host, input.repository, refreshed);
      });
    },

    updateChangeRequest: (input) =>
      changeRequestPath(input).pipe(
        Effect.flatMap((path) =>
          api
            .request({
              host: input.host,
              operation: "updateChangeRequest",
              method: "PUT",
              path,
              body: {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { description: input.body }),
              },
            })
            .pipe(Effect.mapError(fail("updateChangeRequest"))),
        ),
        Effect.asVoid,
      ),

    comment: Effect.fn("CodeupPullRequestProvider.comment")(function* (input) {
      const patchSets = yield* listPatchSets(input);
      const patch = latestSourcePatchSet(patchSets);
      const bizId = patch ? patchSetBizId(patch) : null;
      if (bizId === null) {
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "comment",
          reason: "failed",
          detail: "Codeup returned no patch set for this merge request.",
        });
      }
      const path = yield* changeRequestPath(input, "/comments");
      yield* api
        .request({
          host: input.host,
          operation: "comment",
          method: "POST",
          path,
          body: {
            comment_type: "GLOBAL_COMMENT",
            content: input.body,
            draft: false,
            resolved: false,
            patchset_biz_id: bizId,
          },
        })
        .pipe(Effect.mapError(fail("comment")));
    }),

    submitReview: Effect.fn("CodeupPullRequestProvider.submitReview")(function* (input) {
      const patchSets = yield* listPatchSets(input);
      const patch = latestSourcePatchSet(patchSets);
      const bizId = patch ? patchSetBizId(patch) : null;
      if (bizId === null) {
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "submitReview",
          reason: "failed",
          detail: "Codeup returned no patch set for this merge request.",
        });
      }
      const commentsPath = yield* changeRequestPath(input, "/comments");
      for (const draft of input.comments) {
        const line =
          draft.position.kind === "added"
            ? draft.position.newLine
            : draft.position.kind === "deleted"
              ? draft.position.oldLine
              : draft.position.side === "right"
                ? draft.position.newLine
                : draft.position.oldLine;
        yield* api
          .request({
            host: input.host,
            operation: "submitReview",
            method: "POST",
            path: commentsPath,
            body: {
              comment_type: "INLINE_COMMENT",
              content: draft.body,
              draft: false,
              resolved: false,
              file_path: draft.path,
              line_number: line,
              patchset_biz_id: bizId,
              from_patchset_biz_id: bizId,
              to_patchset_biz_id: bizId,
            },
          })
          .pipe(Effect.mapError(fail("submitReview")));
      }
      const opinion = mapReviewVerdict(input.verdict);
      if (opinion !== null || input.body.trim() !== "") {
        const reviewPath = yield* changeRequestPath(input, "/review");
        yield* api
          .request({
            host: input.host,
            operation: "submitReview",
            method: "POST",
            path: reviewPath,
            body: {
              ...(opinion === null ? {} : { reviewOpinion: opinion }),
              ...(input.body.trim() === "" ? {} : { reviewComment: input.body }),
            },
          })
          .pipe(Effect.mapError(fail("submitReview")));
      }
    }),

    replyToThread: Effect.fn("CodeupPullRequestProvider.replyToThread")(function* (input) {
      const patchSets = yield* listPatchSets(input);
      const patch = latestSourcePatchSet(patchSets);
      const bizId = patch ? patchSetBizId(patch) : null;
      if (bizId === null) {
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "replyToThread",
          reason: "failed",
          detail: "Codeup returned no patch set for this merge request.",
        });
      }
      const path = yield* changeRequestPath(input, "/comments");
      yield* api
        .request({
          host: input.host,
          operation: "replyToThread",
          method: "POST",
          path,
          body: {
            comment_type: "INLINE_COMMENT",
            content: input.body,
            draft: false,
            resolved: false,
            patchset_biz_id: bizId,
            parent_comment_biz_id: input.threadId,
          },
        })
        .pipe(Effect.mapError(fail("replyToThread")));
    }),

    setReaction: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "setReaction",
          reason: "failed",
          detail: "Codeup does not support reactions.",
        }),
      ),

    setThreadResolution: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "setThreadResolution",
          reason: "failed",
          detail: "Codeup does not expose thread resolution over OpenAPI yet.",
        }),
      ),

    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),

    setReviewerRequest: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("codeup"),
          operation: "setReviewerRequest",
          reason: "failed",
          detail: "Codeup reviewer assignment is not wired yet.",
        }),
      ),
  };

  return provider;
});
