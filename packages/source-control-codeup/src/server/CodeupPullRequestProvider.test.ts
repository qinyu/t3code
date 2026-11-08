import { assert, makeMethods } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { afterEach, describe, it as vitestIt } from "vite-plus/test";

import { clearRegisteredCodeupHosts } from "../shared/codeupHosts.ts";

import * as CodeupApi from "./CodeupApi.ts";
import * as CodeupCredentials from "./CodeupCredentials.ts";
import * as CodeupPullRequestProvider from "./CodeupPullRequestProvider.ts";

const it = makeMethods(vitestIt);

afterEach(() => {
  clearRegisteredCodeupHosts();
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly body: unknown;
  readonly token: string | undefined;
}

function fakeCodeup(
  routes: Record<string, unknown | ((request: SentRequest) => unknown)>,
  options: {
    readonly status?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly organizationId?: string | null;
  } = {},
) {
  const sent: Array<SentRequest> = [];
  const organizationId =
    options.organizationId === undefined ? "org-central" : options.organizationId;
  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      const url = new URL(request.url);
      const entry: SentRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        host: url.host,
        body:
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined,
        token: request.headers["x-yunxiao-token"],
      };
      sent.push(entry);
      void Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      const route = routes[`${entry.method} ${entry.path}`];
      const response =
        route === undefined
          ? new Response(encodeJson({ errorMessage: "not found" }), { status: 404 })
          : new Response(encodeJson(typeof route === "function" ? route(entry) : route), {
              status: options.status ?? 200,
            });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    },
  );
  const layer = CodeupApi.layer.pipe(
    Layer.provideMerge(CodeupCredentials.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(
      Layer.succeed(
        HostProcess.Environment,
        options.env ?? {
          ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN: "pt-env",
          ...(organizationId ? { ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID: organizationId } : {}),
        },
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { layer, sent };
}

const target = {
  cwd: "/repo",
  host: "codeup.aliyun.com",
  repository: "group/repo",
  number: 7,
};

const detail = {
  localId: 7,
  title: "Change",
  status: "UNDER_REVIEW",
  sourceBranch: "feature",
  targetBranch: "master",
  description: "Body",
  webUrl: "https://codeup.aliyun.com/group/repo/change/7",
  createTime: "2026-09-12T12:00:00Z",
  updateTime: "2026-09-12T12:30:00Z",
  conflictCheckStatus: "NO_CONFLICT",
  allRequirementsPass: true,
  author: { userId: "u1", username: "alice", name: "Alice" },
  reviewers: [{ userId: "u2", username: "bob", name: "Bob", reviewOpinionStatus: "PASS" }],
  totalCommentCount: 1,
};

const patchSets = [
  {
    patchSetBizId: "patch-source",
    relatedMergeItemType: "MERGE_SOURCE",
    commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    versionNo: 2,
  },
  {
    patchSetBizId: "patch-target",
    relatedMergeItemType: "MERGE_TARGET",
    commitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    versionNo: 1,
  },
];

describe("CodeupPullRequestProvider", () => {
  it.effect("loads merge request detail, checks, and activity over central OpenAPI paths", () => {
    const server = fakeCodeup({
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7":
        detail,
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/diffs/patches":
        patchSets,
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/ciCheckList":
        {
          checkList: [
            { taskName: "CI", state: "PASS", buildUrl: "https://flow/1", required: true },
          ],
          commitStatuses: [{ context: "lint", state: "success" }],
        },
      "POST /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/comments/list":
        [
          {
            commentBizId: "c1",
            comment_type: "GLOBAL_COMMENT",
            content: "Looks good",
            author: { username: "alice", name: "Alice" },
            createTime: "2026-09-12T12:10:00Z",
          },
          {
            commentBizId: "t1",
            comment_type: "INLINE_COMMENT",
            content: "Nit",
            file_path: "src/a.ts",
            line_number: 4,
            author: { username: "bob", name: "Bob" },
            createTime: "2026-09-12T12:15:00Z",
            resolved: false,
          },
        ],
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/compares": {
        diffs: [
          {
            diff: "diff --git a/src/a.ts b/src/a.ts\n",
            newPath: "src/a.ts",
            oldPath: "src/a.ts",
          },
        ],
        commits: [
          {
            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            title: "Add feature",
            committedDate: "2026-09-12T11:00:00Z",
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const provider = yield* CodeupPullRequestProvider.make;
      const change = yield* provider.getChangeRequest(target);
      assert.strictEqual(change.number, 7);
      assert.strictEqual(change.reviewDecision, "approved");
      assert.strictEqual(change.checks.length, 2);
      assert.strictEqual(change.checksState, "passing");
      const activity = yield* provider.getChangeRequestActivity(target);
      assert.strictEqual(activity.comments.length, 2);
      assert.strictEqual(activity.reviewThreads.length, 1);
      assert.strictEqual(activity.commits[0]?.oid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const compare = server.sent.find((request) => request.path.endsWith("/compares"));
      assert.strictEqual(compare?.query.get("from"), "master");
      assert.strictEqual(compare?.query.get("to"), "feature");
      assert.strictEqual(
        server.sent
          .find((request) => request.path.endsWith("/ciCheckList"))
          ?.query.get("patchSetBizId"),
        "patch-source",
      );
      assert.strictEqual(server.sent[0]?.token, "pt-env");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("uses Region paths without an organization id", () => {
    const server = fakeCodeup(
      {
        "GET /oapi/v1/codeup/repositories/group%2Frepo/changeRequests/7": detail,
        "GET /oapi/v1/codeup/repositories/group%2Frepo/changeRequests/7/diffs/patches": patchSets,
        "GET /oapi/v1/codeup/repositories/group%2Frepo/changeRequests/7/ciCheckList": {
          checkList: [],
        },
      },
      { organizationId: null, env: { ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN: "pt-region" } },
    );
    return Effect.gen(function* () {
      const provider = yield* CodeupPullRequestProvider.make;
      const change = yield* provider.getChangeRequest(target);
      assert.strictEqual(change.title, "Change");
      assert.isTrue(server.sent.every((request) => !request.path.includes("/organizations/")));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("merges with no-fast-forward and reviews with PASS", () => {
    const server = fakeCodeup({
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7":
        detail,
      "POST /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/merge":
        { result: true },
      "GET /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/diffs/patches":
        patchSets,
      "POST /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/comments":
        { result: true },
      "POST /oapi/v1/codeup/organizations/org-central/repositories/group%2Frepo/changeRequests/7/review":
        { result: true },
    });
    return Effect.gen(function* () {
      const provider = yield* CodeupPullRequestProvider.make;
      yield* provider.runAction({ ...target, action: "merge", mergeMethod: "merge" });
      yield* provider.submitReview({
        ...target,
        verdict: "approve",
        body: "LGTM",
        comments: [
          {
            path: "src/a.ts",
            body: "nit",
            position: { kind: "added", newLine: 4 },
          },
        ],
      });
      const merge = server.sent.find((request) => request.path.endsWith("/merge"));
      assert.deepStrictEqual(merge?.body, { mergeType: "no-fast-forward" });
      const review = server.sent.find((request) => request.path.endsWith("/review"));
      assert.deepStrictEqual(review?.body, {
        reviewOpinion: "PASS",
        reviewComment: "LGTM",
      });
      const inline = server.sent.find((request) => {
        if (request.method !== "POST" || !request.path.endsWith("/comments")) return false;
        if (request.body === null || typeof request.body !== "object") return false;
        return (request.body as { comment_type?: string }).comment_type === "INLINE_COMMENT";
      });
      assert.isDefined(inline);
      assert.strictEqual(
        (inline.body as { patchset_biz_id?: string }).patchset_biz_id,
        "patch-source",
      );
    }).pipe(Effect.provide(server.layer));
  });
});
