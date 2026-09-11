import { useRef, useState, useSyncExternalStore } from "react";

import type { LocalFirstRepository, LocalProperty, LocalRoom } from "../../local";
import type { LocalChecklistItem } from "../../local";
import type { PhotoUploadQueue } from "./photo-upload-queue";
import { PhotoReferenceBrowser, photoElementLabel } from "./PhotoReferenceBrowser";

interface PhotoCaptureControlProps {
  repository: LocalFirstRepository;
  queue: PhotoUploadQueue;
  property: LocalProperty;
  room: LocalRoom;
  checklistItem: LocalChecklistItem;
}

function usePhotoMetadata(repository: LocalFirstRepository, propertyId: string, roomId: string, checklistItemId: string) {
  const state = useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
  return Object.values(state.photoMetadata)
    .filter((photo) => photo.propertyId === propertyId && photo.roomId === roomId && photo.checklistItemId === checklistItemId)
    .sort((left, right) => right.createdAt - left.createdAt);
}

/** Context comes from the active measurement item; users never have to re-classify a photo in a separate gallery. */
export function PhotoCaptureControl({ repository, queue, property, room, checklistItem }: PhotoCaptureControlProps) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [note, setNote] = useState("");
  const photos = usePhotoMetadata(repository, property.id, room.id, checklistItem.id);

  async function selectPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    setCompressing(true);
    try {
      await queue.enqueue(file, {
        property,
        room,
        checklistItem: { id: checklistItem.id, label: checklistItem.label, elementId: checklistItem.elementId },
        note,
      });
      setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "사진을 기기에 저장하지 못했습니다.");
    } finally {
      setCompressing(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="photo-context" aria-label="사진 첨부">
      <input
        ref={input}
        className="photo-file-input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        aria-label="첨부할 사진 선택"
        onChange={(event) => { void selectPhoto(event.currentTarget.files?.[0]); }}
      />
      <div className="photo-context-copy">
        <button type="button" disabled={compressing} onClick={() => input.current?.click()}>
          {compressing ? "사진 압축 중…" : "📷 사진 첨부"}
        </button>
        <p><strong>{property.name} / {room.name}</strong><span>{checklistItem.label} · {photoElementLabel(checklistItem.elementId, room) ?? "공간 전체"}</span></p>
      </div>
      <label className="photo-note-input">사진 메모 (선택)<textarea aria-label="사진 메모 (선택)" value={note} maxLength={4_000} onChange={(event) => setNote(event.target.value)} placeholder="사진에서 확인할 위치나 상태를 남기세요" /><small>{note.length} / 4000</small></label>
      {photos.length > 0 ? <PhotoReferenceBrowser repository={repository} references={photos.map((photo) => ({ photo, roomLabel: room.name, checklistLabel: checklistItem.label, propertyLabel: property.name, elementLabel: photoElementLabel(photo.elementId, room) }))} /> : <p className="photo-empty">아직 사진이 없습니다. 첨부하면 이 측정 항목에 연결됩니다.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
