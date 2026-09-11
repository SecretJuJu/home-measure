import type { ChecklistCreate, MeasurementCreate } from "@home-measure/domain";

import type { LocalChecklistItem, LocalMeasurement } from "../../local";

export interface ChecklistCompletion {
  total: number;
  complete: number;
  requiredMissing: LocalChecklistItem[];
  recommendedMissing: LocalChecklistItem[];
  skipped: LocalChecklistItem[];
  percentage: number;
}

export function isChecklistComplete(item: Pick<LocalChecklistItem, "status">): boolean {
  return item.status === "complete";
}

export function checklistCompletion(items: readonly LocalChecklistItem[]): ChecklistCompletion {
  const complete = items.filter(isChecklistComplete);
  const incomplete = items.filter((item) => !isChecklistComplete(item));
  const requiredMissing = incomplete.filter((item) => item.required);
  const recommendedMissing = incomplete.filter((item) => !item.required && item.status !== "skipped");
  const skipped = incomplete.filter((item) => item.status === "skipped");
  return {
    total: items.length,
    complete: complete.length,
    requiredMissing,
    recommendedMissing,
    skipped,
    percentage: items.length === 0 ? 0 : Math.round((complete.length / items.length) * 100),
  };
}

export function measurementTypeForItem(item: Pick<ChecklistCreate, "label" | "category">): MeasurementCreate["type"] {
  if (item.category === "utility") return "count";
  if (item.label.includes("높이")) return "height";
  if (item.label.includes("깊이") || item.label.includes("세로")) return "depth";
  if (item.label.includes("최소") || item.label.includes("통과") || item.label.includes("거리")) return "distance";
  return "width";
}

export function measurementForChecklist(
  item: LocalChecklistItem,
  measurements: Readonly<Record<string, LocalMeasurement>>,
): LocalMeasurement | undefined {
  return item.measurementId ? measurements[item.measurementId] : undefined;
}

