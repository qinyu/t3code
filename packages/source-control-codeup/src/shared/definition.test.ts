import { afterEach, describe, expect, it } from "vite-plus/test";
import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";

import { clearRegisteredCodeupHosts, registerCodeupHost } from "./codeupHosts.ts";
import {
  applyCodeupSettings,
  canonicalizePullRequestUrl,
  definition,
  parsePullRequestUrl,
} from "./definition.ts";

afterEach(() => {
  clearRegisteredCodeupHosts();
});

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Codeup change request URLs", () => {
  it("parses nested-group merge request links", () => {
    expect(parse("https://codeup.aliyun.com/qimao/public/sdk/message/change/55")).toEqual({
      host: "codeup.aliyun.com",
      repository: "qimao/public/sdk/message",
      number: 55,
      repositoryUrl: "https://codeup.aliyun.com/qimao/public/sdk/message",
    });
    expect(
      definition.isChangeRequestReference(
        "https://codeup.aliyun.com/qimao/public/sdk/message/change/55",
      ),
    ).toBe(true);
    expect(canonicalizePullRequestUrl("https://codeup.aliyun.com/Acme/Repo/change/8/files")).toBe(
      "https://codeup.aliyun.com/acme/repo/change/8",
    );
  });

  it("rejects other hosts and routes", () => {
    for (const url of [
      "https://github.com/team/repo/pull/7",
      "https://codeup.aliyun.com/team/repo/pull/7",
      "https://codeup.aliyun.com/team/repo/change/abc",
      "https://evil-codeup.example/team/repo/change/7",
      "not a url",
    ]) {
      expect(parsePullRequestUrl(url), url).toBeNull();
      expect(definition.isChangeRequestReference(url), url).toBe(false);
      expect(canonicalizePullRequestUrl(url), url).toBe(url);
    }
  });

  it("builds merge request URLs below the repository", () => {
    expect(
      definition.changeRequestUrl({
        host: "codeup.aliyun.com",
        repository: "team/repo",
        number: 8,
      }),
    ).toBe("https://codeup.aliyun.com/team/repo/change/8");
  });
});

describe("Codeup remotes", () => {
  it("recognises codeup.aliyun.com without settings", () => {
    expect(recognizeRemoteWith(definition, "https://codeup.aliyun.com/a/b")).toEqual({
      kind: "codeup",
      name: "Codeup",
      baseUrl: "https://codeup.aliyun.com",
    });
    expect(recognizeRemoteWith(definition, "git@codeup.aliyun.com:team/repo.git")?.kind).toBe(
      "codeup",
    );
  });

  it("recognises a Region host after settings apply", () => {
    expect(recognizeRemoteWith(definition, "https://git.company.example/a/b")).toBeNull();
    applyCodeupSettings({
      token: "",
      organizationId: "",
      apiBaseUrl: "https://yunxiao.company.example",
      webHost: "git.company.example",
    });
    expect(recognizeRemoteWith(definition, "https://git.company.example/a/b")).toEqual({
      kind: "codeup",
      name: "Codeup Self-Hosted",
      baseUrl: "https://git.company.example",
    });
  });

  it("registers an explicit host via the host table", () => {
    registerCodeupHost({
      webHost: "code.internal.test",
      apiBaseUrl: "https://api.internal.test",
      organizationId: "org-1",
    });
    expect(
      recognizeRemoteWith(definition, "ssh://git@code.internal.test/group/repo.git")?.kind,
    ).toBe("codeup");
  });
});
