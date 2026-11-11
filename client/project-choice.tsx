import { useState } from "react";
import type { Project } from "../shared/model";
import { PickerGroup, PickerRow } from "./picker";
import { t } from "../shared/i18n";

/**
 * Which project an addition goes to on an unfiltered group board (Add memory, Import ideas; BOARD-GROUPS-SPEC §4):
 * one picker row that opens the group's projects in place. Callers show it only when there are several.
 */
export function ProjectChoice({ projects, value, disabled = false, onChange }: { projects: readonly Pick<Project, "id" | "title">[]; value: string; disabled?: boolean; onChange(projectId: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <PickerGroup>
      <PickerRow
        first
        open={open}
        title={t("Project")}
        icon="Folder"
        value={value}
        placeholder={t("Project")}
        disabled={disabled}
        options={projects.map((p) => ({ value: p.id, label: p.title }))}
        onToggle={() => setOpen(!open)}
        onChange={(id) => {
          setOpen(false);
          onChange(id);
        }}
      />
    </PickerGroup>
  );
}
