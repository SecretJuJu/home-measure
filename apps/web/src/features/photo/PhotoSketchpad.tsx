import { annotationVersion, type AnnotationPoint, type PhotoAnnotation, type PhotoMark } from "@home-measure/domain";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

import type { LocalPhotoMetadata } from "../../local";
import {
  appendPoint,
  markAt,
  markMidpoint,
  meaningfulMarks,
  penPath,
  toAnnotationPoint,
  type AnnotationTool,
} from "./annotation";

export interface PhotoSketchpadProps {
  photo: LocalPhotoMetadata;
  /** Object URL for the cached image; null while it is still being read from IndexedDB. */
  source: string | null;
  onSave: (annotation: PhotoAnnotation) => Promise<void> | void;
  onClose: () => void;
}

const tools: ReadonlyArray<{ tool: AnnotationTool; label: string; hint: string }> = [
  { tool: "measure", label: "치수", hint: "길이를 잰 곳을 끌어서 선을 긋고 숫자를 적습니다." },
  { tool: "pen", label: "펜", hint: "손가락이나 펜으로 자유롭게 그립니다." },
  { tool: "note", label: "글씨", hint: "누른 자리에 짧은 메모를 답니다." },
  { tool: "erase", label: "지우개", hint: "지울 표시를 누릅니다." },
];

/**
 * The photo as a sheet of paper. Measurements are written straight onto what was photographed, which
 * is how a tape reading is actually recorded on site, and the marks stay editable because they are
 * kept as coordinates rather than burnt into the image.
 */
export function PhotoSketchpad({ photo, source, onSave, onClose }: PhotoSketchpadProps) {
  const [marks, setMarks] = useState<PhotoMark[]>(() => photo.annotation?.marks ?? []);
  const [tool, setTool] = useState<AnnotationTool>("measure");
  const [drawing, setDrawing] = useState<PhotoMark | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  const aspect = photo.width && photo.height ? photo.width / photo.height : 4 / 3;
  const visible = useMemo(() => (drawing ? [...marks, drawing] : marks), [marks, drawing]);

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  function pointFrom(event: ReactPointerEvent<HTMLDivElement>): AnnotationPoint | null {
    const bounds = sheetRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return toAnnotationPoint({ x: event.clientX, y: event.clientY }, bounds);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointFrom(event);
    if (!point) return;
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "erase") {
      const target = markAt(marks, point);
      if (target) setMarks(marks.filter((mark) => mark.id !== target.id));
      return;
    }
    if (tool === "note") {
      const mark: PhotoMark = { id: newMarkId(), kind: "note", position: point, text: "" };
      setMarks([...marks, mark]);
      setEditing(mark.id);
      return;
    }
    if (tool === "pen") {
      setDrawing({ id: newMarkId(), kind: "pen", points: [point, point] });
      return;
    }
    setDrawing({ id: newMarkId(), kind: "measure", start: point, end: point, text: "" });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drawing) return;
    const point = pointFrom(event);
    if (!point) return;
    setDrawing(drawing.kind === "pen"
      ? { ...drawing, points: appendPoint(drawing.points, point) }
      : drawing.kind === "measure" ? { ...drawing, end: point } : drawing);
  }

  function handlePointerUp() {
    if (!drawing) return;
    setDrawing(null);
    // A stroke that never moved is a stray tap, not a mark.
    if (drawing.kind === "pen" && drawing.points.length < 3) return;
    if (drawing.kind === "measure" && Math.hypot(drawing.end.x - drawing.start.x, drawing.end.y - drawing.start.y) < 0.02) return;
    setMarks([...marks, drawing]);
    if (drawing.kind === "measure") setEditing(drawing.id);
  }

  function setText(id: string, text: string) {
    setMarks(marks.map((mark) => (mark.id === id && mark.kind !== "pen" ? { ...mark, text: text.slice(0, 40) } : mark)));
  }

  function closeText() {
    // An empty label leaves nothing to read, so the mark goes with it.
    setMarks(marks.filter((mark) => mark.id !== editing || mark.kind === "pen" || mark.text.trim() !== ""));
    setEditing(null);
  }

  async function save() {
    setSaving(true);
    await onSave({ version: annotationVersion, marks: meaningfulMarks(marks) });
    setSaving(false);
    onClose();
  }

  const editingMark = marks.find((mark) => mark.id === editing);

  return (
    <main className="photo-sketchpad" aria-label="사진에 필기">
      <header className="sketchpad-header">
        <button type="button" onClick={onClose} aria-label="사진 닫기">닫기</button>
        <p>{photo.note ?? "사진 실측"}</p>
        <button type="button" className="primary-action" disabled={saving} onClick={() => void save()} aria-label="필기 저장">
          {saving ? "저장 중…" : "저장"}
        </button>
      </header>

      <div className="sketchpad-sheet-frame">
        <div
          ref={sheetRef}
          className="sketchpad-sheet"
          style={{ aspectRatio: String(aspect) }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {source
            ? <img src={source} alt="실측 사진" draggable={false} />
            : <p className="sketchpad-missing">이 기기에 사진 원본이 없습니다. 표시만 편집할 수 있습니다.</p>}
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="사진 위 표시">
            {visible.map((mark) => <MarkDrawing key={mark.id} mark={mark} active={mark.id === editing} />)}
          </svg>
        </div>
      </div>

      {editingMark && editingMark.kind !== "pen" && (
        <form className="sketchpad-text" onSubmit={(event) => { event.preventDefault(); closeText(); }}>
          <label>
            {editingMark.kind === "measure" ? "길이" : "메모"}
            <input
              ref={textRef}
              value={editingMark.text}
              onChange={(event) => setText(editingMark.id, event.target.value)}
              placeholder={editingMark.kind === "measure" ? "예: 2,340 mm" : "예: 배관 위치"}
              aria-label={editingMark.kind === "measure" ? "길이 입력" : "메모 입력"}
            />
          </label>
          <button type="submit" className="secondary-action">확인</button>
        </form>
      )}

      <footer className="sketchpad-tools">
        {tools.map(({ tool: candidate, label }) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={tool === candidate}
            className={tool === candidate ? "selected" : ""}
            onClick={() => setTool(candidate)}
          >{label}</button>
        ))}
        <button type="button" disabled={marks.length === 0} onClick={() => setMarks(marks.slice(0, -1))} aria-label="마지막 표시 취소">되돌리기</button>
        <small>{tools.find((item) => item.tool === tool)?.hint}</small>
      </footer>
    </main>
  );
}

function MarkDrawing({ mark, active }: { mark: PhotoMark; active: boolean }) {
  const className = `sketch-mark ${mark.kind}${active ? " active" : ""}`;
  if (mark.kind === "pen") {
    return <path className={className} d={penPath(mark.points, 1_000, 1_000)} fill="none" />;
  }
  if (mark.kind === "note") {
    return <g className={className}>
      <circle cx={mark.position.x * 1_000} cy={mark.position.y * 1_000} r="9" />
      <text x={mark.position.x * 1_000 + 16} y={mark.position.y * 1_000 + 6}>{mark.text}</text>
    </g>;
  }
  const middle = markMidpoint(mark);
  return <g className={className}>
    <line x1={mark.start.x * 1_000} y1={mark.start.y * 1_000} x2={mark.end.x * 1_000} y2={mark.end.y * 1_000} />
    {[mark.start, mark.end].map((point, index) => (
      <circle key={index} cx={point.x * 1_000} cy={point.y * 1_000} r="7" />
    ))}
    {mark.text && <text x={middle.x * 1_000} y={middle.y * 1_000 - 12} textAnchor="middle">{mark.text}</text>}
  </g>;
}

function newMarkId(): string {
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `mark_${entropy}`;
}
