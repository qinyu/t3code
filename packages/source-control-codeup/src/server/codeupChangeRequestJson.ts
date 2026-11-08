import {
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestReviewThread,
  type PullRequestState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CodeupActor = Schema.Struct({
  userId: Schema.optional(Schema.NullOr(Schema.String)),
  username: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
  reviewOpinionStatus: Schema.optional(Schema.NullOr(Schema.String)),
  hasReviewed: Schema.optional(Schema.Boolean),
});

export const CodeupChangeRequestDetail = Schema.Struct({
  localId: Schema.Number,
  title: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  workInProgress: Schema.optional(Schema.Boolean),
  webUrl: Schema.optional(Schema.String),
  detailUrl: Schema.optional(Schema.String),
  createTime: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updateTime: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedRevision: Schema.optional(Schema.NullOr(Schema.String)),
  ahead: Schema.optional(Schema.Number),
  behind: Schema.optional(Schema.Number),
  conflictCheckStatus: Schema.optional(Schema.String),
  allRequirementsPass: Schema.optional(Schema.Boolean),
  supportMergeFastForwardOnly: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(CodeupActor)),
  reviewers: Schema.optional(Schema.Array(CodeupActor)),
  totalCommentCount: Schema.optional(Schema.Number),
  unResolvedCommentCount: Schema.optional(Schema.Number),
});

export const CodeupComment = Schema.Struct({
  commentBizId: Schema.optional(Schema.String),
  bizId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  content: Schema.optional(Schema.String),
  commentType: Schema.optional(Schema.String),
  comment_type: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.NullOr(Schema.String)),
  file_path: Schema.optional(Schema.NullOr(Schema.String)),
  lineNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  line_number: Schema.optional(Schema.NullOr(Schema.Number)),
  resolved: Schema.optional(Schema.Boolean),
  parentCommentBizId: Schema.optional(Schema.NullOr(Schema.String)),
  parent_comment_biz_id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(CodeupActor)),
  createTime: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CodeupCommentList = Schema.Union([
  Schema.Array(CodeupComment),
  Schema.Struct({ result: Schema.Array(CodeupComment) }),
  Schema.Struct({ comments: Schema.Array(CodeupComment) }),
]);

export const CodeupPatchSet = Schema.Struct({
  patchSetBizId: Schema.optional(Schema.String),
  relatedMergeItemType: Schema.optional(Schema.String),
  commitId: Schema.optional(Schema.String),
  createTime: Schema.optional(Schema.NullOr(Schema.String)),
  versionNo: Schema.optional(Schema.Number),
});

export const CodeupPatchSetList = Schema.Union([
  Schema.Array(CodeupPatchSet),
  Schema.Struct({ result: Schema.Array(CodeupPatchSet) }),
]);

export const CodeupCompareDiff = Schema.Struct({
  diff: Schema.optional(Schema.String),
  oldPath: Schema.optional(Schema.String),
  newPath: Schema.optional(Schema.String),
  newFile: Schema.optional(Schema.Boolean),
  deletedFile: Schema.optional(Schema.Boolean),
  renamedFile: Schema.optional(Schema.Boolean),
});

export const CodeupCompare = Schema.Struct({
  diffs: Schema.optional(Schema.Array(CodeupCompareDiff)),
  commits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        shortId: Schema.optional(Schema.String),
        title: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
        authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
        committedDate: Schema.optional(Schema.NullOr(Schema.String)),
        authorName: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export const CodeupCiCheckItem = Schema.Struct({
  taskName: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  buildUrl: Schema.optional(Schema.String),
  targetUrl: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});

export const CodeupCiCheckList = Schema.Struct({
  checkList: Schema.optional(Schema.Array(CodeupCiCheckItem)),
  commitStatuses: Schema.optional(Schema.Array(CodeupCiCheckItem)),
  status: Schema.optional(Schema.String),
});

export function commentsOf(
  list: typeof CodeupCommentList.Type,
): ReadonlyArray<typeof CodeupComment.Type> {
  if (Array.isArray(list)) return list;
  const record = list as {
    readonly result?: ReadonlyArray<typeof CodeupComment.Type>;
    readonly comments?: ReadonlyArray<typeof CodeupComment.Type>;
  };
  return record.result ?? record.comments ?? [];
}

export function patchSetsOf(
  list: typeof CodeupPatchSetList.Type,
): ReadonlyArray<typeof CodeupPatchSet.Type> {
  if (Array.isArray(list)) return list;
  return (list as { readonly result: ReadonlyArray<typeof CodeupPatchSet.Type> }).result;
}

const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";

export function commentId(comment: typeof CodeupComment.Type): string {
  return (
    comment.commentBizId ??
    comment.bizId ??
    (comment.id === undefined ? "comment" : String(comment.id))
  );
}

export function mapComment(
  comment: typeof CodeupComment.Type,
  changeRequestUrl: string,
): PullRequestComment {
  const type = comment.commentType ?? comment.comment_type ?? "GLOBAL_COMMENT";
  const path = comment.filePath ?? comment.file_path ?? null;
  return {
    id: commentId(comment),
    kind: type === "INLINE_COMMENT" ? "review-comment" : "issue-comment",
    author: mapActor(comment.author),
    body: comment.content ?? "",
    createdAt: comment.createTime ?? comment.createdAt ?? UNKNOWN_TIME,
    url: changeRequestUrl,
    path,
    reviewState: null,
  };
}

export function mapReviewThreads(
  comments: ReadonlyArray<typeof CodeupComment.Type>,
): ReadonlyArray<PullRequestReviewThread> {
  const roots = comments.filter((comment) => {
    const type = comment.commentType ?? comment.comment_type;
    return (
      type === "INLINE_COMMENT" && !(comment.parentCommentBizId ?? comment.parent_comment_biz_id)
    );
  });
  return roots.map((root) => {
    const id = commentId(root);
    const replies = comments.filter(
      (comment) => (comment.parentCommentBizId ?? comment.parent_comment_biz_id) === id,
    );
    const path = root.filePath ?? root.file_path ?? "unknown";
    const line = root.lineNumber ?? root.line_number ?? null;
    const threadComments = [root, ...replies].map((comment) => ({
      id: commentId(comment),
      author: mapActor(comment.author),
      body: comment.content ?? "",
      createdAt: comment.createTime ?? comment.createdAt ?? UNKNOWN_TIME,
      url: null,
    }));
    return {
      id,
      path,
      line,
      side: "right" as const,
      isResolved: root.resolved === true,
      isOutdated: false,
      comments: threadComments,
      commentCount: threadComments.length,
    };
  });
}

export function mapCommits(compare: typeof CodeupCompare.Type): ReadonlyArray<PullRequestCommit> {
  return (compare.commits ?? []).flatMap((commit) => {
    const oid = commit.id?.trim();
    if (!oid) return [];
    return [
      {
        oid,
        messageHeadline: commit.title ?? commit.message?.split("\n")[0] ?? oid.slice(0, 8),
        committedDate: commit.committedDate ?? commit.authoredDate ?? UNKNOWN_TIME,
      },
    ];
  });
}

export function comparePatch(compare: typeof CodeupCompare.Type): string {
  return (compare.diffs ?? [])
    .map((diff) => {
      if (diff.diff && diff.diff.trim() !== "") return diff.diff;
      const oldPath = diff.oldPath ?? "/dev/null";
      const newPath = diff.newPath ?? "/dev/null";
      return `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n`;
    })
    .join("\n");
}

export function latestSourcePatchSet(
  patchSets: ReadonlyArray<typeof CodeupPatchSet.Type>,
): typeof CodeupPatchSet.Type | null {
  const sources = patchSets.filter(
    (patch) => patch.relatedMergeItemType === "MERGE_SOURCE" || patch.relatedMergeItemType == null,
  );
  const pool = sources.length > 0 ? sources : patchSets;
  return pool.toSorted((left, right) => (right.versionNo ?? 0) - (left.versionNo ?? 0))[0] ?? null;
}

export function patchSetBizId(patch: typeof CodeupPatchSet.Type): string | null {
  return patch.patchSetBizId?.trim() || null;
}

export type CodeupChangeRequestStatus =
  | "UNDER_DEV"
  | "UNDER_REVIEW"
  | "TO_BE_MERGED"
  | "CLOSED"
  | "MERGED"
  | string;

export function mapChangeRequestState(status: CodeupChangeRequestStatus): PullRequestState {
  switch (status) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "UNDER_DEV":
    case "UNDER_REVIEW":
    case "TO_BE_MERGED":
      return "open";
    default:
      return "open";
  }
}

export function mapIsDraft(input: {
  readonly status?: CodeupChangeRequestStatus | undefined;
  readonly workInProgress?: boolean | undefined;
}): boolean {
  return input.workInProgress === true || input.status === "UNDER_DEV";
}

export function mapMergeability(input: {
  readonly conflictCheckStatus?: string | undefined;
  readonly allRequirementsPass?: boolean | undefined;
  readonly status?: CodeupChangeRequestStatus | undefined;
}): PullRequestMergeability {
  if (input.conflictCheckStatus === "HAS_CONFLICT") return "conflicting";
  if (input.conflictCheckStatus === "CHECKING") return "unknown";
  if (input.status === "TO_BE_MERGED" && input.allRequirementsPass === true) return "mergeable";
  if (input.conflictCheckStatus === "NO_CONFLICT") return "mergeable";
  return "unknown";
}

export function mapReviewDecision(
  reviewers:
    | ReadonlyArray<{ readonly reviewOpinionStatus?: string | null | undefined }>
    | undefined,
): PullRequestReviewDecision | null {
  if (!reviewers || reviewers.length === 0) return null;
  if (reviewers.some((reviewer) => reviewer.reviewOpinionStatus === "NOT_PASS")) {
    return "changes-requested";
  }
  const approved = reviewers.filter((reviewer) => reviewer.reviewOpinionStatus === "PASS");
  return approved.length > 0 ? "approved" : null;
}

export function mapActor(
  input:
    | {
        readonly userId?: string | null | undefined;
        readonly username?: string | null | undefined;
        readonly name?: string | null | undefined;
        readonly avatarUrl?: string | null | undefined;
        readonly avatar?: string | null | undefined;
      }
    | null
    | undefined,
): PullRequestActor | null {
  if (!input) return null;
  const login = input.username?.trim() || input.name?.trim();
  if (!login) return null;
  return {
    login,
    name: input.name?.trim() || null,
    avatarUrl: input.avatarUrl ?? input.avatar ?? null,
  };
}

export function mapCheckStatus(state: string | undefined): PullRequestCheck["status"] {
  switch ((state ?? "").toUpperCase()) {
    case "PASS":
    case "SUCCESS":
      return "success";
    case "FAIL":
    case "FAILED":
    case "FAILURE":
      return "failure";
    case "RUNNING":
    case "PENDING":
    case "IN_PROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

export function mapChecksState(
  checks: ReadonlyArray<Pick<PullRequestCheck, "status">>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

export function mapCiCheck(input: {
  readonly taskName?: string | undefined;
  readonly state?: string | undefined;
  readonly buildUrl?: string | undefined;
  readonly targetUrl?: string | undefined;
  readonly context?: string | undefined;
  readonly description?: string | undefined;
  readonly required?: boolean | undefined;
}): PullRequestCheck {
  return {
    name: input.taskName ?? input.context ?? "check",
    status: mapCheckStatus(input.state),
    description: input.description ?? null,
    url: input.buildUrl ?? input.targetUrl ?? null,
    ...(input.required === undefined ? {} : { required: input.required }),
  };
}

export function mapMergeType(
  method: "merge" | "squash" | "rebase" | undefined,
  supportMergeFastForwardOnly?: boolean,
): string {
  if (supportMergeFastForwardOnly === true) return "ff-only";
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      return "rebase";
    case "merge":
    default:
      return "no-fast-forward";
  }
}

export function mapReviewVerdict(
  verdict: "comment" | "approve" | "request-changes",
): string | null {
  switch (verdict) {
    case "approve":
      return "PASS";
    case "request-changes":
      return "NOT_PASS";
    case "comment":
      return null;
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}
