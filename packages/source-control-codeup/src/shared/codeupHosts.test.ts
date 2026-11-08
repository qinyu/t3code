import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearRegisteredCodeupHosts,
  codeupApiPath,
  codeupHostConfig,
  codeupRepositoryPath,
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_HOST,
  encodeRepositoryId,
  isCodeupHost,
  normalizeApiBaseUrl,
  parseCodeupRemote,
  registerCodeupHost,
} from "./codeupHosts.ts";

afterEach(() => {
  clearRegisteredCodeupHosts();
});

describe("codeupHosts", () => {
  it("recognises the central host and hostnames that include codeup", () => {
    expect(isCodeupHost(DEFAULT_WEB_HOST)).toBe(true);
    expect(isCodeupHost("CODEUP.aliyun.com")).toBe(true);
    expect(isCodeupHost("git.codeup.example.com")).toBe(true);
    expect(isCodeupHost("gitlab.example.com")).toBe(false);
  });

  it("registers Region hosts from settings so remotes without codeup in the name resolve", () => {
    expect(isCodeupHost("git.company.example")).toBe(false);
    registerCodeupHost({
      webHost: "git.company.example",
      apiBaseUrl: "https://yunxiao.company.example",
      organizationId: null,
    });
    expect(codeupHostConfig("git.company.example")).toEqual({
      webHost: "git.company.example",
      apiBaseUrl: "https://yunxiao.company.example",
      organizationId: null,
    });
    expect(parseCodeupRemote("https://git.company.example/group/repo.git")).toEqual({
      host: "git.company.example",
      repository: "group/repo",
    });
  });

  it("parses nested group remotes and rejects short paths", () => {
    expect(parseCodeupRemote("https://codeup.aliyun.com/org/group/repo.git")).toEqual({
      host: DEFAULT_WEB_HOST,
      repository: "org/group/repo",
    });
    expect(parseCodeupRemote("git@codeup.aliyun.com:org/repo.git")).toEqual({
      host: DEFAULT_WEB_HOST,
      repository: "org/repo",
    });
    expect(codeupRepositoryPath("solo")).toBeNull();
    expect(parseCodeupRemote("https://github.com/org/repo.git")).toBeNull();
  });

  it("builds central and Region OpenAPI paths", () => {
    expect(
      codeupApiPath({
        organizationId: "60d54f3daccf2bbd6659f3ad",
        suffix: "/repositories/a%2Fb",
      }),
    ).toBe("/oapi/v1/codeup/organizations/60d54f3daccf2bbd6659f3ad/repositories/a%2Fb");
    expect(codeupApiPath({ organizationId: null, suffix: "repositories/a%2Fb" })).toBe(
      "/oapi/v1/codeup/repositories/a%2Fb",
    );
    expect(encodeRepositoryId("org/group/repo")).toBe("org%2Fgroup%2Frepo");
  });

  it("normalises API base URLs", () => {
    expect(normalizeApiBaseUrl("")).toBe(DEFAULT_API_BASE_URL);
    expect(normalizeApiBaseUrl("openapi-rdc.aliyuncs.com/")).toBe(
      "https://openapi-rdc.aliyuncs.com",
    );
    expect(normalizeApiBaseUrl("https://yunxiao.example/")).toBe("https://yunxiao.example");
  });
});
