import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as CodeupApi from "./CodeupApi.ts";
import * as CodeupCredentials from "./CodeupCredentials.ts";
import * as CodeupPullRequestProvider from "./CodeupPullRequestProvider.ts";
import * as CodeupSourceControlProvider from "./CodeupSourceControlProvider.ts";

const services = CodeupApi.layer.pipe(Layer.provideMerge(CodeupCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: CodeupSourceControlProvider.make,
  discovery: CodeupSourceControlProvider.makeDiscovery,
  pullRequests: CodeupPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
