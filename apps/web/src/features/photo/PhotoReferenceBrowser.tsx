import { useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";
import { useModalFocus } from "../../ui/useModalFocus";
import { utilityLabel } from "../floor-plan/geometry";
import type { LocalFirstRepository, LocalPhotoMetadata, LocalRoom } from "../../local";

export interface PhotoReference {
  photo: LocalPhotoMetadata;
  roomLabel: string;
  checklistLabel: string | null;
  propertyLabel?: string;
  elementLabel?: string | null;
}

export function photoUploadStatusLabel(photo: LocalPhotoMetadata): string {
  switch (photo.uploadStatus) {
    case "pending": return "사진 업로드 대기";
    case "uploading": return "사진 업로드 중";
    case "uploaded": return "사진 업로드됨";
    case "failed": return "사진 업로드 재시도 대기";
  }
}

export function photoElementLabel(elementId: string | null, room: LocalRoom | undefined): string | null {
  if (!elementId) return null;
  if (!room) return "연결된 객체";
  const doorIndex = room.layout.doors.findIndex((door) => door.id === elementId);
  if (doorIndex >= 0) return `문 ${doorIndex + 1}`;
  const windowIndex = room.layout.windows.findIndex((window) => window.id === elementId);
  if (windowIndex >= 0) return `창문 ${windowIndex + 1}`;
  const utility = room.layout.utilities.find((item) => item.id === elementId);
  return utility ? utilityLabel(utility) : "연결된 객체";
}

function photoContextLabel(reference: PhotoReference): string {
  return [reference.roomLabel, reference.checklistLabel].filter((value): value is string => Boolean(value)).join(" · ");
}

/** Only device-local Blob URLs are used for previews; R2 keys are never rendered as browser URLs. */
export function LocalPhotoPreview({
  repository,
  photo,
  alt,
  className = "photo-thumbnail",
}: {
  repository: LocalFirstRepository;
  photo: LocalPhotoMetadata;
  alt: string;
  className?: string;
}) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    void repository.db.photoBlobs.get(photo.id).then((cached) => {
      if (!active || !cached) return;
      objectUrl = URL.createObjectURL(cached.blob);
      setSource(objectUrl);
    }).catch(() => { if (active) setSource(null); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo.id, photo.uploadStatus, repository]);

  if (!source) return <span className={`${className} photo-preview-placeholder`} role="img" aria-label={`${alt}: 기기에 미리보기 없음`}><span aria-hidden="true">▧</span><small>미리보기 없음</small></span>;
  return <img className={className} src={source} alt={alt} />;
}

/** Keeps each summary image tied to the room and checklist record that created it. */
export function PhotoReferenceBrowser({ repository, references }: { repository: LocalFirstRepository; references: readonly PhotoReference[] }) {
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const selected = references.find((reference) => reference.photo.id === selectedPhotoId) ?? null;

  if (references.length === 0) return <p className="summary-empty">실측 항목에서 사진을 첨부하면 공간과 체크리스트 맥락을 유지한 채 여기에서 확인할 수 있습니다.</p>;

  return <>
    <div className="photo-reference-grid" aria-label="연결된 사진 목록">
      {references.map((reference) => {
        const context = photoContextLabel(reference);
        return <button
          key={reference.photo.id}
          type="button"
          className="photo-reference-card"
          aria-label={`사진 열기: ${context}`}
          onClick={(event) => {
            // Safari does not focus buttons on tap; remember the actual photo opener.
            event.currentTarget.focus();
            setSelectedPhotoId(reference.photo.id);
          }}
        >
          <LocalPhotoPreview repository={repository} photo={reference.photo} alt={`${context} 사진 미리보기`} className="photo-reference-thumbnail" />
          <span className="photo-reference-copy"><strong>{context}</strong><small data-photo-status={reference.photo.uploadStatus}>{photoUploadStatusLabel(reference.photo)}</small>{reference.elementLabel && <small>{reference.elementLabel} 연결</small>}{reference.photo.note && <em>{reference.photo.note}</em>}</span>
        </button>;
      })}
    </div>
    {selected && <PhotoDetailOverlay repository={repository} reference={selected} onClose={() => setSelectedPhotoId(null)} />}
  </>;
}

function PhotoDetailOverlay({ repository, reference, onClose }: { repository: LocalFirstRepository; reference: PhotoReference; onClose: () => void }) {
  const context = photoContextLabel(reference);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus(backdrop, onClose);
  return createPortal(<div ref={backdrop} className="photo-detail-backdrop" role="presentation" onClick={onClose}>
    <section className="photo-detail-overlay" role="dialog" aria-modal="true" aria-labelledby="photo-detail-title" onClick={(event) => event.stopPropagation()}>
      <div className="photo-detail-heading"><div><p className="eyebrow">연결된 사진</p><h3 id="photo-detail-title">{context}</h3></div><button type="button" aria-label="사진 상세 닫기" onClick={onClose}>닫기</button></div>
      <LocalPhotoPreview repository={repository} photo={reference.photo} alt={`${context} 사진 상세 미리보기`} className="photo-detail-image" />
      <dl className="photo-detail-metadata">{reference.propertyLabel && <div><dt>집</dt><dd>{reference.propertyLabel}</dd></div>}<div><dt>공간 · 측정 항목</dt><dd>{context}</dd></div><div><dt>평면도 연결</dt><dd>{reference.elementLabel ?? "공간 전체 기록"}</dd></div><div><dt>업로드 상태</dt><dd data-photo-status={reference.photo.uploadStatus}>{photoUploadStatusLabel(reference.photo)}</dd></div><div><dt>사진 메모</dt><dd>{reference.photo.note || "메모 없음"}</dd></div></dl>
      {reference.photo.uploadStatus === "uploaded" && <p className="photo-preview-help">업로드 완료 후 이 기기의 임시 이미지를 정리했습니다. 현재 화면에서는 저장된 사진의 연결 정보와 메모를 확인할 수 있습니다.</p>}
      {reference.photo.uploadStatus === "failed" && <p className="photo-preview-help">업로드에 실패했습니다. 인터넷이 다시 연결되면 자동으로 재시도합니다.</p>}
    </section>
  </div>, document.body);
}
