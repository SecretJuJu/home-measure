import { useMemo, useSyncExternalStore } from "react";

import type { LocalChecklistItem, LocalFirstRepository, LocalProperty, LocalRoom } from "../../local";
import { PhotoReferenceBrowser, type PhotoReference } from "../photo";
import { photoElementLabel } from "../photo/PhotoReferenceBrowser";
import { checklistCompletion, measurementForChecklist } from "./completion";

interface PropertySummaryProps {
  repository: LocalFirstRepository;
  property: LocalProperty;
  onBack: () => void;
}

interface ApplianceSpace {
  name: string;
  dimensions: string[];
}

function useLocalState(repository: LocalFirstRepository) {
  return useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
}

function recordedApplianceSpaces(
  items: readonly LocalChecklistItem[],
  measurements: Parameters<typeof measurementForChecklist>[1],
): ApplianceSpace[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const match = /^(냉장고|세탁기) 공간 (가로|깊이|높이)$/.exec(item.label);
    if (!match) continue;
    const measurement = measurementForChecklist(item, measurements);
    if (!measurement || measurement.value === null || measurement.value === undefined) continue;
    const appliance = match[1];
    const axis = match[2];
    if (!appliance || !axis) continue;
    const dimensions = groups.get(appliance) ?? [];
    const index = axis === "가로" ? 0 : axis === "깊이" ? 1 : 2;
    dimensions[index] = `${measurement.value} mm`;
    groups.set(appliance, dimensions);
  }
  return [...groups.entries()].map(([name, dimensions]) => ({ name: `${name} 공간`, dimensions }));
}

function narrowestPassage(items: readonly LocalChecklistItem[], measurements: Parameters<typeof measurementForChecklist>[1]): number | undefined {
  const values = items
    .filter((item) => /최소|통과|좁/.test(item.label))
    .map((item) => measurementForChecklist(item, measurements)?.value)
    .filter((value): value is number => value !== null && value !== undefined);
  return values.length > 0 ? Math.min(...values) : undefined;
}

/** A shopping-oriented record of captured dimensions, never a generic analytics dashboard. */
export function PropertySummary({ repository, property, onBack }: PropertySummaryProps) {
  const state = useLocalState(repository);
  const rooms = useMemo(
    () => Object.values(state.rooms).filter((room) => room.propertyId === property.id).sort((left, right) => left.createdAt - right.createdAt),
    [property.id, state.rooms],
  );
  const items = useMemo(
    () => Object.values(state.checklistItems).filter((item) => item.propertyId === property.id),
    [property.id, state.checklistItems],
  );
  const completion = checklistCompletion(items);
  const applianceSpaces = recordedApplianceSpaces(items, state.measurements);
  const passage = narrowestPassage(items, state.measurements);
  const attachedPhotos = useMemo<PhotoReference[]>(() => Object.values(state.photoMetadata)
    .filter((photo) => photo.propertyId === property.id)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((photo) => ({
      photo,
      propertyLabel: property.name,
      elementLabel: photoElementLabel(photo.elementId, photo.roomId ? state.rooms[photo.roomId] : undefined),
      roomLabel: photo.roomId ? state.rooms[photo.roomId]?.name ?? "삭제된 공간" : "집 전체",
      checklistLabel: photo.checklistItemId ? state.checklistItems[photo.checklistItemId]?.label ?? "삭제된 체크리스트 항목" : null,
    })), [property.id, property.name, state.checklistItems, state.photoMetadata, state.rooms]);

  return (
    <main className="property-summary" aria-label="실측 요약">
      <header className="summary-header"><div><p className="eyebrow">실측 요약</p><h1>{property.name}</h1></div><button type="button" onClick={onBack}>편집으로 돌아가기</button></header>
      <section className="summary-hero" aria-label="실측 완료도"><strong>{completion.percentage}%</strong><div><h2>실측 {completion.complete} / {completion.total} 완료</h2><p>필수 미측정 {completion.requiredMissing.length}개 · 권장 미측정 {completion.recommendedMissing.length}개</p></div></section>
      <div className="summary-priorities">
        <section className="summary-section summary-passage" aria-labelledby="passage-title"><h2 id="passage-title">최소 통과 폭</h2><article className="summary-card"><h3>가장 좁은 기록</h3><p>{passage === undefined ? "아직 기록 없음" : `${passage} mm`}</p><small>실측한 통로의 최소값</small></article></section>
        <section className="summary-section" aria-labelledby="appliance-space-title"><h2 id="appliance-space-title">기록된 가전 설치 공간</h2>{applianceSpaces.length > 0 ? <div className="summary-grid">{applianceSpaces.map((space) => <article className="summary-card" key={space.name}><h3>{space.name}</h3><dl className="summary-dimensions">{["가로", "깊이", "높이"].map((axis, index) => <div key={axis}><dt>{axis}</dt><dd>{space.dimensions[index] ?? "미측정"}</dd></div>)}</dl></article>)}</div> : <p className="summary-empty">냉장고 또는 세탁기 공간 치수를 기록하면 여기에서 바로 확인할 수 있습니다.</p>}</section>
      </div>
      <section className="summary-section" aria-labelledby="room-dimensions-title"><h2 id="room-dimensions-title">공간 치수 <small>가로 × 세로</small></h2><div className="summary-grid">{rooms.map((room) => <RoomDimension key={room.id} room={room} />)}</div>{rooms.length === 0 && <p className="summary-empty">등록한 공간이 없습니다.</p>}</section>
      <section className="summary-section" aria-labelledby="spatial-details-title"><h2 id="spatial-details-title">문과 주요 설비 <small>위치 x × y · mm</small></h2><div className="summary-grid">{rooms.map((room) => <RoomSpatialDetails key={room.id} room={room} />)}</div></section>
      <section className="summary-section" aria-labelledby="photo-title"><h2 id="photo-title">연결된 사진</h2><p className="summary-photo-count">{attachedPhotos.length}개 참조 · 각 사진은 촬영한 공간과 체크리스트 항목을 함께 표시합니다.</p><PhotoReferenceBrowser repository={repository} references={attachedPhotos} /></section>
      <section className="summary-section summary-missing" aria-labelledby="missing-title"><h2 id="missing-title">떠나기 전 확인 · 필수 미측정 {completion.requiredMissing.length}</h2>{completion.requiredMissing.length > 0 ? <ul>{completion.requiredMissing.map((item) => <li key={item.id}><span>{item.roomId ? state.rooms[item.roomId]?.name ?? "삭제된 공간" : "집 전체"}</span><strong>{item.label}</strong><small>{item.status === "skipped" ? "나중에" : "미측정"}</small></li>)}</ul> : <p className="summary-empty">필수 미측정 항목이 없습니다.</p>}</section>
    </main>
  );
}

function RoomDimension({ room }: { room: LocalRoom }) {
  return <article className="summary-card"><h3>{room.name}</h3><p>{room.layout.size.width} × {room.layout.size.height} mm</p></article>;
}

function RoomSpatialDetails({ room }: { room: LocalRoom }) {
  const { doors, utilities } = room.layout;
  return <article className="summary-card summary-spatial-card" aria-label={`${room.name} 문과 주요 설비`}>
    <h3>{room.name}</h3>
    <section aria-label="문 폭">
      <h4>문 폭</h4>
      {doors.length > 0
        ? <ul className="summary-detail-list">{doors.map((door, index) => <li key={door.id}>문 {index + 1} · {wallLabel(door.wall)} · {door.width} mm</li>)}</ul>
        : <p className="summary-empty">기록된 문 없음</p>}
    </section>
    <section aria-label="주요 설비 위치">
      <h4>주요 설비 위치</h4>
      {utilities.length > 0
        ? <ul className="summary-detail-list">{utilities.map((utility) => <li key={utility.id}>{utilityLabel(utility.type)} · {utility.position.x} × {utility.position.y} mm</li>)}</ul>
        : <p className="summary-empty">기록된 주요 설비 없음</p>}
    </section>
  </article>;
}

function wallLabel(wall: LocalRoom["layout"]["doors"][number]["wall"]): string {
  return {
    north: "위쪽 벽",
    east: "오른쪽 벽",
    south: "아래쪽 벽",
    west: "왼쪽 벽",
    notchHorizontal: "안쪽 가로 벽",
    notchVertical: "안쪽 세로 벽",
  }[wall];
}

function utilityLabel(type: LocalRoom["layout"]["utilities"][number]["type"]): string {
  const labels = {
    outlet: "콘센트",
    lan: "LAN",
    water: "수도",
    drain: "배수구",
    gas: "가스",
    boiler: "보일러",
    ac: "에어컨",
    interphone: "인터폰",
  } as const;
  return labels[type];
}
