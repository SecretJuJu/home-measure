import type { ClientId } from "@home-measure/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { LocalChecklistItem, LocalFirstRepository, LocalMeasurement, LocalProperty, LocalRoom } from "../../local";
import { PhotoCaptureControl, type PhotoUploadQueue } from "../photo";
import { measurementForChecklist, measurementTypeForItem } from "./completion";
import { useVisualViewport } from "../../ui/useVisualViewport";
import { newClientId } from "./definitions";

interface MeasurementModeProps {
  repository: LocalFirstRepository;
  photoQueue: PhotoUploadQueue;
  property: LocalProperty;
  room: LocalRoom;
  initialItem: LocalChecklistItem;
  onExit: () => void;
}

function useLocalState(repository: LocalFirstRepository) {
  return useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
}

function mutationOperation(method: "POST" | "PATCH", path: string, data: Record<string, unknown>) {
  const clientMutationId = newClientId("mutation");
  return { clientMutationId, method, path, body: { clientMutationId, data } };
}

/** Focused field flow: one incomplete item at a time, with the bottom actions kept above the keyboard area. */
export function MeasurementMode({ repository, photoQueue, property, room, initialItem, onExit }: MeasurementModeProps) {
  const state = useLocalState(repository);
  const viewportStyle = useVisualViewport();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  async function runAction(action: () => Promise<void>) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try { await action(); } finally { savingRef.current = false; setSaving(false); }
  }
  const [currentItemId, setCurrentItemId] = useState<ClientId>(initialItem.id);
  const roomItems = useMemo(
    () => Object.values(state.checklistItems)
      .filter((item) => item.propertyId === property.id && item.roomId === room.id)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt),
    [property.id, room.id, state.checklistItems],
  );
  const currentItem = roomItems.find((item) => item.id === currentItemId) ?? roomItems.find((item) => item.status === "pending");
  const currentMeasurement = currentItem ? measurementForChecklist(currentItem, state.measurements) : undefined;
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentMeasurement?.value === null || currentMeasurement?.value === undefined ? "" : String(currentMeasurement.value));
    setNote(currentMeasurement?.note ?? "");
    setError(null);
  }, [currentItem?.id, currentMeasurement?.id, currentMeasurement?.note, currentMeasurement?.value]);

  const completedCount = roomItems.filter((item) => item.status === "complete").length;
  const progressPosition = currentItem ? roomItems.findIndex((item) => item.id === currentItem.id) + 1 : roomItems.length;

  function nextPending(afterId: ClientId): LocalChecklistItem | undefined {
    const currentIndex = roomItems.findIndex((item) => item.id === afterId);
    const ordered = [...roomItems.slice(currentIndex + 1), ...roomItems.slice(0, currentIndex)];
    return ordered.find((item) => item.status === "pending");
  }

  async function saveAndAdvance() {
    if (!currentItem) return;
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue) || numericValue <= 0 || numericValue > 100_000) {
      setError("1부터 100,000 사이의 밀리미터 값을 입력하세요.");
      return;
    }
    const timestamp = Date.now();
    const existing = currentMeasurement;
    const measurementId = existing?.id ?? newClientId("measurement");
    const measurement: LocalMeasurement = {
      id: measurementId,
      propertyId: property.id,
      roomId: room.id,
      elementId: currentItem.elementId,
      checklistItemId: currentItem.id,
      type: measurementTypeForItem(currentItem),
      value: numericValue,
      unit: "mm",
      note: note.trim() || null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      dirty: false,
    };
    const measurementData = {
      elementId: measurement.elementId,
      checklistItemId: measurement.checklistItemId,
      type: measurement.type,
      value: measurement.value,
      unit: measurement.unit,
      note: measurement.note,
    };
    try {
      await repository.persistOptimisticChange({
        entityKind: "measurement",
        entity: measurement,
        operation: existing
          ? mutationOperation("PATCH", `/measurements/${measurement.id}`, measurementData)
          : mutationOperation("POST", "/measurements", { id: measurement.id, propertyId: measurement.propertyId, roomId: measurement.roomId, ...measurementData }),
      });
      const completedItem: LocalChecklistItem = {
        ...currentItem,
        status: "complete",
        measurementId,
        updatedAt: timestamp,
        dirty: false,
      };
      await repository.persistOptimisticChange({
        entityKind: "checklist",
        entity: completedItem,
        operation: mutationOperation("PATCH", `/checklist/${currentItem.id}`, { status: "complete", measurementId }),
      });
    } catch {
      setError("실측값을 기기에 저장하지 못했습니다. 다시 시도하세요.");
      return;
    }
    const next = nextPending(currentItem.id);
    if (next) setCurrentItemId(next.id);
    else onExit();
  }

  async function skipForLater() {
    if (!currentItem) return;
    const deferredItem: LocalChecklistItem = { ...currentItem, status: "skipped", updatedAt: Date.now(), dirty: false };
    try {
      await repository.persistOptimisticChange({
        entityKind: "checklist",
        entity: deferredItem,
        operation: mutationOperation("PATCH", `/checklist/${currentItem.id}`, { status: "skipped" }),
      });
    } catch {
      setError("나중에 처리 상태를 기기에 저장하지 못했습니다.");
      return;
    }
    const next = nextPending(currentItem.id);
    if (next) setCurrentItemId(next.id);
    else onExit();
  }

  if (!currentItem) {
    return <main className="measurement-mode completion-surface" style={viewportStyle}><p className="eyebrow">실측 모드</p><h1>{room.name}의 미측정 항목이 없습니다.</h1><button type="button" className="primary-action" onClick={onExit}>체크리스트로 돌아가기</button></main>;
  }

  return (
    <main className="measurement-mode" style={viewportStyle} data-compact={typeof viewportStyle.height === "number" && viewportStyle.height <= 550} aria-label="실측 모드" aria-busy={saving}>
      <header className="measurement-header"><div><p className="eyebrow">{property.name} / 실측 모드</p><h1>{room.name}</h1></div><div className="measurement-progress"><span>{progressPosition} / {roomItems.length}</span><small>완료 {completedCount}</small></div><button type="button" disabled={saving} onClick={onExit}>목록으로</button></header>
      <div className="measurement-scroll"><section className="measurement-card" aria-labelledby="measurement-label">
        <div className="measurement-item-heading"><p className="measurement-required">{currentItem.required ? "필수 항목" : "권장 항목"}</p>
        <h2 id="measurement-label">{currentItem.label}</h2></div>
        <label className="measurement-value-label">실측값 (mm)<div className="measurement-input"><input autoFocus type="number" enterKeyHint="next" inputMode="numeric" min="1" max="100000" value={value} onChange={(event) => setValue(event.target.value)} aria-label={`${currentItem.label} 밀리미터`} /><span>mm</span></div></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="measurement-secondary"><label>메모 (선택)<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="측정 위치나 조건을 남기세요" /></label>
        <PhotoCaptureControl key={currentItem.id} repository={repository} queue={photoQueue} property={property} room={room} checklistItem={currentItem} />
        </div>
      </section></div>
      <footer className="measurement-actions"><span className="measurement-save-hint">기기에 저장한 후 다음 항목으로 이동</span><button type="button" disabled={saving} onClick={() => void runAction(skipForLater)}>나중에</button><button type="button" disabled={saving} className="primary-action" onClick={() => void runAction(saveAndAdvance)}>{saving ? "저장 중…" : "저장 후 다음 →"}</button></footer>
    </main>
  );
}
