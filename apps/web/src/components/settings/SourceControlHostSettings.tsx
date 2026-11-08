import type { EnvironmentId } from "@t3tools/contracts";
import {
  syncRegisteredSourceControlHosts,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import * as Equal from "effect/Equal";
import { useEffect, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

export function SourceControlHostSettings({
  environmentId,
  definition,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition & {
    readonly settings: NonNullable<SourceControlDefinition["settings"]>;
  };
  readonly onSaved: () => void;
}) {
  const hosts = useEnvironmentSettings(environmentId, (settings) => settings.sourceControlHosts);
  const saved = hosts[definition.kind];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the module-level Codeup host table in step with Settings so client remote recognition matches the server.
  useEffect(() => {
    syncRegisteredSourceControlHosts({ sourceControlHosts: hosts });
  }, [hosts]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [saving, setSaving] = useState(false);
  const formDefinition = { settingsSchema: definition.settings };
  const hasSaved = Object.values(saved ?? {}).some((value) => value !== "");

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { [definition.kind]: fields } } },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  return (
    // Locked while saving, so an edit made mid-request is not overwritten by the saved value.
    <fieldset disabled={saving} className="contents">
      <ProviderSettingsForm
        definition={formDefinition}
        value={saved ?? {}}
        idPrefix={`source-control-${definition.kind}-${environmentId}`}
        variant="settings"
        environmentId={environmentId}
        onChange={(next) => {
          const fields = next ?? {};
          const changed = Object.fromEntries(
            Object.entries(fields).filter(([key, value]) => !Equal.equals(saved?.[key], value)),
          );
          const cleared = Object.keys(saved ?? {}).filter((key) => !(key in fields));
          void save({ ...changed, ...Object.fromEntries(cleared.map((key) => [key, ""])) });
        }}
      />
      {hasSaved ? (
        <div className="flex justify-end pt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void save(Object.fromEntries(Object.keys(saved ?? {}).map((key) => [key, ""])))
            }
          >
            Remove
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
