import { assert, makeMethods } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { afterEach, describe, it as vitestIt } from "vite-plus/test";

import { clearRegisteredCodeupHosts } from "../shared/codeupHosts.ts";
import * as CodeupCredentials from "./CodeupCredentials.ts";

const it = makeMethods(vitestIt);

afterEach(() => {
  clearRegisteredCodeupHosts();
});

describe("CodeupCredentials", () => {
  it("reads Yunxiao env vars for the configured web host", () => {
    const connection = CodeupCredentials.environmentConnection({
      ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN: "pt-env",
      ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID: "org-env",
      ALIBABA_CLOUD_YUNXIAO_API_BASE_URL: "openapi-rdc.aliyuncs.com",
    });
    assert.strictEqual(connection.token, "pt-env");
    assert.strictEqual(connection.organizationId, "org-env");
    assert.strictEqual(connection.apiBaseUrl, "https://openapi-rdc.aliyuncs.com");
    assert.strictEqual(connection.webHost, "codeup.aliyun.com");
  });

  it.effect("prefers a saved token over the environment", () => {
    const layer = CodeupCredentials.layer.pipe(
      Layer.provideMerge(TestSourceControlHost.layer({})),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN: "pt-env",
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    );
    return Effect.gen(function* () {
      const credentials = yield* CodeupCredentials.CodeupCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({
        sourceControlHosts: {
          codeup: {
            token: "pt-saved",
            organizationId: "org-saved",
            apiBaseUrl: "https://openapi-rdc.aliyuncs.com",
            webHost: "codeup.aliyun.com",
          },
        },
      });
      const credential = yield* credentials.get("codeup.aliyun.com");
      assert.strictEqual(Redacted.value(credential.token), "pt-saved");
      assert.strictEqual(credential.source, "settings");
      assert.strictEqual(credential.organizationId, "org-saved");
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the environment when Settings has no token", () => {
    const layer = CodeupCredentials.layer.pipe(
      Layer.provideMerge(TestSourceControlHost.layer({})),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN: "pt-env",
          ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID: "org-env",
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    );
    return Effect.gen(function* () {
      const credentials = yield* CodeupCredentials.CodeupCredentials;
      const credential = yield* credentials.get("codeup.aliyun.com");
      assert.strictEqual(Redacted.value(credential.token), "pt-env");
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(credential.organizationId, "org-env");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when neither Settings nor the environment has a token", () => {
    const layer = CodeupCredentials.layer.pipe(
      Layer.provideMerge(TestSourceControlHost.layer({})),
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    );
    return Effect.gen(function* () {
      const credentials = yield* CodeupCredentials.CodeupCredentials;
      const error = yield* Effect.flip(credentials.get("codeup.aliyun.com"));
      assert.strictEqual(error._tag, "CodeupCredentialMissingError");
    }).pipe(Effect.provide(layer));
  });
});
