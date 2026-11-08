import { describe, expect, it } from "vite-plus/test";

import {
  comparePatch,
  latestSourcePatchSet,
  mapChangeRequestState,
  mapChecksState,
  mapCiCheck,
  mapIsDraft,
  mapMergeability,
  mapMergeType,
  mapReviewDecision,
  mapReviewThreads,
  mapReviewVerdict,
} from "./codeupChangeRequestJson.ts";

describe("codeupChangeRequestJson", () => {
  it("maps Codeup statuses onto open, closed, and merged", () => {
    expect(mapChangeRequestState("UNDER_DEV")).toBe("open");
    expect(mapChangeRequestState("UNDER_REVIEW")).toBe("open");
    expect(mapChangeRequestState("TO_BE_MERGED")).toBe("open");
    expect(mapChangeRequestState("CLOSED")).toBe("closed");
    expect(mapChangeRequestState("MERGED")).toBe("merged");
  });

  it("treats UNDER_DEV and workInProgress as draft", () => {
    expect(mapIsDraft({ status: "UNDER_DEV" })).toBe(true);
    expect(mapIsDraft({ status: "UNDER_REVIEW", workInProgress: true })).toBe(true);
    expect(mapIsDraft({ status: "UNDER_REVIEW" })).toBe(false);
  });

  it("maps conflict and requirement fields onto mergeability", () => {
    expect(mapMergeability({ conflictCheckStatus: "HAS_CONFLICT" })).toBe("conflicting");
    expect(mapMergeability({ status: "TO_BE_MERGED", allRequirementsPass: true })).toBe(
      "mergeable",
    );
    expect(mapMergeability({ conflictCheckStatus: "CHECKING" })).toBe("unknown");
  });

  it("maps reviewer opinions onto review decisions", () => {
    expect(mapReviewDecision([{ reviewOpinionStatus: "PASS" }])).toBe("approved");
    expect(
      mapReviewDecision([{ reviewOpinionStatus: "PASS" }, { reviewOpinionStatus: "NOT_PASS" }]),
    ).toBe("changes-requested");
    expect(mapReviewDecision([])).toBeNull();
  });

  it("maps CI check rows and aggregate check state", () => {
    const pass = mapCiCheck({ taskName: "build", state: "PASS", buildUrl: "https://flow/1" });
    expect(pass).toMatchObject({
      name: "build",
      status: "success",
      url: "https://flow/1",
    });
    const running = mapCiCheck({ taskName: "scan", state: "RUNNING" });
    expect(running.status).toBe("pending");
    expect(mapChecksState([pass, running])).toBe("pending");
    expect(mapChecksState([pass, mapCiCheck({ taskName: "x", state: "FAIL" })])).toBe("failing");
  });

  it("maps merge methods, preferring ff-only when the repository requires it", () => {
    expect(mapMergeType("merge")).toBe("no-fast-forward");
    expect(mapMergeType("squash")).toBe("squash");
    expect(mapMergeType("rebase")).toBe("rebase");
    expect(mapMergeType("merge", true)).toBe("ff-only");
  });

  it("maps review verdicts onto Codeup opinion statuses", () => {
    expect(mapReviewVerdict("approve")).toBe("PASS");
    expect(mapReviewVerdict("request-changes")).toBe("NOT_PASS");
    expect(mapReviewVerdict("comment")).toBeNull();
  });

  it("picks the newest MERGE_SOURCE patch set and joins compare diffs", () => {
    expect(
      latestSourcePatchSet([
        { patchSetBizId: "old", relatedMergeItemType: "MERGE_SOURCE", versionNo: 1 },
        { patchSetBizId: "new", relatedMergeItemType: "MERGE_SOURCE", versionNo: 3 },
        { patchSetBizId: "target", relatedMergeItemType: "MERGE_TARGET", versionNo: 9 },
      ])?.patchSetBizId,
    ).toBe("new");
    expect(
      comparePatch({
        diffs: [
          { diff: "diff --git a/a.ts b/a.ts\n" },
          { oldPath: "b.ts", newPath: "b.ts", diff: "" },
        ],
      }),
    ).toContain("diff --git a/a.ts b/a.ts");
  });

  it("groups inline comments into review threads", () => {
    const threads = mapReviewThreads([
      {
        commentBizId: "root",
        comment_type: "INLINE_COMMENT",
        content: "root",
        file_path: "a.ts",
        line_number: 2,
        resolved: false,
      },
      {
        commentBizId: "reply",
        comment_type: "INLINE_COMMENT",
        content: "reply",
        parent_comment_biz_id: "root",
      },
      {
        commentBizId: "global",
        comment_type: "GLOBAL_COMMENT",
        content: "overall",
      },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments).toHaveLength(2);
    expect(threads[0]?.path).toBe("a.ts");
  });
});
