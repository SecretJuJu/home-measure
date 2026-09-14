import type { ClientId } from "@home-measure/domain";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { FloorPlanSelection } from "../floor-plan";
import type { LocalChecklistItem, LocalProperty, LocalRoom, LocalFirstRepository } from "../../local";
import { checklistCompletion } from "./completion";
import { newClientId } from "./definitions";

interface ChecklistPanelProps {
  repository: LocalFirstRepository;
  property: LocalProperty;
  room: LocalRoom | undefined;
  selection: FloorPlanSelection;
  onSelectionChange: (selection: FloorPlanSelection) => void;
  onStartMeasurement: (room: LocalRoom, item: LocalChecklistItem) => void;
  onOpenSummary: () => void;
  onOpenPhotos: () => void;
}

interface LinkedElement {
  id: ClientId;
  label: string;
  selection: Exclude<FloorPlanSelection, null>;
}

function useLocalState(repository: LocalFirstRepository) {
  return useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
}

function mutationOperation(method: "POST" | "PATCH", path: string, data: Record<string, unknown>) {
  const clientMutationId = newClientId("mutation");
  return { clientMutationId, method, path, body: { clientMutationId, data } };
}

function roomElements(room: LocalRoom): LinkedElement[] {
  return [
    ...room.layout.doors.map((door) => ({ id: door.id, label: `문 · ${door.width} mm`, selection: { kind: "door" as const, roomId: room.id, elementId: door.id } })),
    ...room.layout.windows.map((window) => ({ id: window.id, label: `창문 · ${window.width} mm`, selection: { kind: "window" as const, roomId: room.id, elementId: window.id } })),
    ...room.layout.utilities.map((utility) => ({ id: utility.id, label: `설비 · ${utility.type}`, selection: { kind: "utility" as const, roomId: room.id, elementId: utility.id } })),
  ];
}

/** Checklist stays adjacent to the canvas so a row and its object are two views of one record. */
export function ChecklistPanel({
  repository,
  property,
  room,
  selection,
  onSelectionChange,
  onStartMeasurement,
  onOpenSummary,
  onOpenPhotos,
}: ChecklistPanelProps) {
  const state = useLocalState(repository);
  const [missingOnly, setMissingOnly] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState({ label: "", required: false, elementId: "" });
  const [activeItemId, setActiveItemId] = useState<ClientId | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const propertyItems = useMemo(
    () => Object.values(state.checklistItems)
      .filter((item) => item.propertyId === property.id)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt),
    [property.id, state.checklistItems],
  );
  const roomItems = room ? propertyItems.filter((item) => item.roomId === room.id) : [];
  const completion = checklistCompletion(propertyItems);
  const roomCompletion = checklistCompletion(roomItems);
  const visibleItems = missingOnly ? roomItems.filter((item) => item.status !== "complete") : roomItems;
  const elements = room ? roomElements(room) : [];
  const selectedElementId = selection && "elementId" in selection ? selection.elementId : null;
  const selectedItem = roomItems.find((item) => item.id === activeItemId && (selectedElementId ? item.elementId === selectedElementId : !item.elementId))
    ?? roomItems.find((item) => selectedElementId && item.elementId === selectedElementId);

  async function addItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room) return;
    const label = draft.label.trim();
    if (!label) return;
    const timestamp = Date.now();
    const item: LocalChecklistItem = {
      id: newClientId("checklist"),
      propertyId: property.id,
      roomId: room.id,
      elementId: draft.elementId ? draft.elementId as ClientId : null,
      label,
      category: "other",
      required: draft.required,
      status: "pending",
      measurementId: null,
      sortOrder: roomItems.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      dirty: false,
    };
    try {
      await repository.persistOptimisticChange({
        entityKind: "checklist",
        entity: item,
        operation: mutationOperation("POST", "/checklist", {
          id: item.id,
          propertyId: item.propertyId,
          roomId: item.roomId,
          elementId: item.elementId,
          label: item.label,
          category: item.category,
          required: item.required,
          status: item.status,
          measurementId: item.measurementId,
          sortOrder: item.sortOrder,
        }),
      });
    } catch {
      setAddError("항목을 기기에 저장하지 못했습니다.");
      return;
    }
    setDraft({ label: "", required: false, elementId: "" });
    setShowAddForm(false);
  }

  function selectItem(item: LocalChecklistItem) {
    setActiveItemId(item.id);
    const linked = item.elementId ? elements.find((element) => element.id === item.elementId) : undefined;
    onSelectionChange(linked?.selection ?? { kind: "room", roomId: item.roomId ?? room?.id ?? property.id });
  }

  const firstIncomplete = roomItems.find((item) => item.status === "pending");

  return (
    <section className="checklist-panel" aria-label="공간 체크리스트">
      <div className="checklist-heading">
        <div>
          <p className="eyebrow">체크리스트</p>
          <h2>{room?.name ?? "공간을 선택하세요"}</h2>
        </div>
        <button type="button" className="secondary-action" onClick={onOpenSummary}>요약 보기</button>
      </div>

      <div className="completion-card" aria-label="실측 완료도">
        <strong>{completion.percentage}%</strong>
        <span>전체 {completion.complete} / {completion.total} 완료</span>
        <small>이 공간 {roomCompletion.complete} / {roomCompletion.total}</small>
        <div className="completion-breakdown">
          <span>필수 미측정 {completion.requiredMissing.length}</span>
          <span>권장 미측정 {completion.recommendedMissing.length}</span>
          {completion.skipped.length > 0 && <span>나중에 {completion.skipped.length}</span>}
        </div>
      </div>

      {room && (
        <div className="checklist-actions">
          <button type="button" className={missingOnly ? "selected" : ""} onClick={() => setMissingOnly(!missingOnly)} aria-pressed={missingOnly}>미측정만 보기</button>
          <button type="button" className="primary-action" onClick={onOpenPhotos}>사진 실측 ▶</button><button type="button" className="secondary-action" disabled={!firstIncomplete} onClick={() => firstIncomplete && onStartMeasurement(room, firstIncomplete)}>실측 모드 ▶</button>
        </div>
      )}

      <div className="checklist-list" aria-live="polite">
        {visibleItems.map((item) => {
          const linked = item.elementId ? elements.find((element) => element.id === item.elementId) : undefined;
          const isCurrent = selectedItem?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`checklist-item ${item.status === "complete" ? "complete" : ""} ${item.required ? "required" : "recommended"} ${isCurrent ? "active" : ""}`}
              onClick={() => selectItem(item)}
              aria-current={isCurrent ? "true" : undefined}
              aria-label={`${item.label}, ${item.required ? "필수" : "권장"}, ${item.status === "complete" ? "완료" : "미측정"}${linked ? ", 평면도 객체 연결됨" : ""}`}
            >
              <span className="checklist-state" aria-hidden="true">{item.status === "complete" ? "✓" : item.status === "skipped" ? "◌" : "○"}</span>
              <span className="checklist-copy"><strong>{item.label}</strong><small>{item.required ? "필수" : "권장"} · {item.status === "complete" ? "완료" : item.status === "skipped" ? "나중에" : "미측정"}{isCurrent ? " · 선택됨" : ""}<span className="checklist-link">{linked ? `↗ ${linked.label} 연결됨` : "공간 기록 · 객체 연결 없음"}</span></small></span>
            </button>
          );
        })}
        {room && visibleItems.length === 0 && <p className="empty-checklist">{missingOnly ? "이 공간의 미측정 항목이 없습니다." : "아직 체크리스트가 없습니다."}</p>}
      </div>

      {room && !showAddForm && <button type="button" className="secondary-action checklist-add" onClick={() => setShowAddForm(true)}>+ 직접 항목 추가</button>}
      {room && showAddForm && (
        <form className="checklist-add-form" onSubmit={(event) => void addItem(event)}>
          <label>항목 이름<input autoFocus value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="예: 붙박이장 내부 폭" /></label>
          <label>평면도 객체 연결 (선택)<select value={draft.elementId} onChange={(event) => setDraft({ ...draft, elementId: event.target.value })}><option value="">공간 전체</option>{elements.map((element) => <option key={element.id} value={element.id}>{element.label}</option>)}</select></label>
          <label className="checkbox-label"><input type="checkbox" checked={draft.required} onChange={(event) => setDraft({ ...draft, required: event.target.checked })} /> 필수 항목</label>
          <div className="form-actions"><button type="button" onClick={() => setShowAddForm(false)}>취소</button><button className="primary-action" type="submit">추가</button></div>
          {addError && <p className="form-error" role="alert">{addError}</p>}
        </form>
      )}
    </section>
  );
}
