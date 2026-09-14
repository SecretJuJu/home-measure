import type { PhotoAnnotation } from "@home-measure/domain";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { LocalFirstRepository, LocalPhotoMetadata, LocalProperty, LocalRoom } from "../../local";
import { ACCEPTED_PHOTO_MIME_TYPES } from "./photo-processing";
import { PhotoSketchpad } from "./PhotoSketchpad";
import type { PhotoUploadQueue } from "./photo-upload-queue";
import { photoUploadStatusLabel } from "./PhotoReferenceBrowser";

export interface PhotoSketchModeProps {
  repository: LocalFirstRepository;
  queue: PhotoUploadQueue;
  property: LocalProperty;
  rooms: LocalRoom[];
  onClose: () => void;
}

function usePhotos(repository: LocalFirstRepository, propertyId: string): LocalPhotoMetadata[] {
  const state = useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
  return Object.values(state.photoMetadata)
    .filter((photo) => photo.propertyId === propertyId)
    .sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * Take a photo, and it opens straight onto the sketchpad. Writing the tape reading on the picture of
 * the thing measured is faster on site than placing the same number on a plan, and the photo carries
 * the context a number alone loses.
 */
export function PhotoSketchMode({ repository, queue, property, rooms, onClose }: PhotoSketchModeProps) {
  const photos = usePhotos(repository, property.id);
  const input = useRef<HTMLInputElement>(null);
  const [roomId, setRoomId] = useState<string>(rooms[0]?.id ?? "");
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPhoto = photos.find((photo) => photo.id === openPhotoId) ?? null;

  useEffect(() => {
    if (!openPhotoId) { setSource(null); return; }
    let url: string | null = null;
    let active = true;
    void repository.db.photoBlobs.get(openPhotoId).then((cached) => {
      if (!active || !cached) return;
      url = URL.createObjectURL(cached.blob);
      setSource(url);
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [openPhotoId, repository]);

  async function capture(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const room = rooms.find((candidate) => candidate.id === roomId);
      const photo = await queue.enqueue(file, {
        property,
        ...(room ? { room: { id: room.id, name: room.name } } : {}),
        note: room ? `${room.name} 실측` : "현장 실측",
      });
      setOpenPhotoId(photo.id);
      void queue.process();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "사진을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function saveAnnotation(photo: LocalPhotoMetadata, annotation: PhotoAnnotation) {
    try {
      await repository.persistOptimisticChange({
        entityKind: "photo",
        entity: { ...photo, annotation },
        operation: annotationOperation(photo.id, annotation),
      });
    } catch {
      setError("필기를 기기에 저장하지 못했습니다.");
    }
  }

  if (openPhoto) {
    return <PhotoSketchpad
      photo={openPhoto}
      source={source}
      onSave={(annotation) => saveAnnotation(openPhoto, annotation)}
      onClose={() => setOpenPhotoId(null)}
    />;
  }

  return (
    <main className="photo-mode" aria-label="사진 실측">
      <header className="photo-mode-header">
        <div>
          <p className="eyebrow">{property.name}</p>
          <h1>사진 실측</h1>
        </div>
        <button type="button" onClick={onClose} aria-label="편집으로 돌아가기">편집으로</button>
      </header>

      <div className="photo-capture-bar">
        <label>
          공간
          <select value={roomId} onChange={(event) => setRoomId(event.target.value)} aria-label="사진을 붙일 공간">
            <option value="">공간 없음</option>
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
        </label>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_PHOTO_MIME_TYPES.join(",")}
          capture="environment"
          onChange={(event) => void capture(event.target.files?.[0])}
          aria-label="사진 촬영"
          hidden
        />
        <button type="button" className="primary-action capture-action" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "사진 처리 중…" : "사진 찍고 필기"}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <ul className="photo-mode-list">
        {photos.map((photo) => (
          <li key={photo.id}>
            <button type="button" onClick={() => setOpenPhotoId(photo.id)} aria-label={`${photo.note ?? "사진"} 열기`}>
              <strong>{photo.note ?? "현장 실측"}</strong>
              <small>{photoUploadStatusLabel(photo)} · 표시 {photo.annotation?.marks.length ?? 0}개</small>
            </button>
          </li>
        ))}
        {photos.length === 0 && <li className="photo-mode-empty">아직 찍은 사진이 없습니다. 위에서 사진을 찍으면 바로 필기 화면이 열립니다.</li>}
      </ul>
    </main>
  );
}

function annotationOperation(photoId: string, annotation: PhotoAnnotation) {
  const clientMutationId = newMutationId();
  return {
    clientMutationId,
    method: "PUT" as const,
    path: `/photos/${photoId}/annotation`,
    body: { clientMutationId, data: annotation },
  };
}

function newMutationId(): string {
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `mutation_${entropy}`;
}
