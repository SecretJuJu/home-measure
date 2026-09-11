import type { ClientId, ClientMutationId } from "@home-measure/domain";

import type { CachedPhotoBlob, LocalFirstRepository, LocalPhotoMetadata, LocalProperty, LocalRoom } from "../../local";
import { newClientId } from "../checklist/definitions";
import {
  compressPhoto,
  photoObjectKey,
  type CompressedPhoto,
  type PhotoCompressionAdapter,
} from "./photo-processing";

export interface PhotoUploadClient {
  upload(photo: LocalPhotoMetadata, cached: CachedPhotoBlob): Promise<void>;
}

export class HttpPhotoUploadClient implements PhotoUploadClient {
  public constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), private readonly basePath = "/api") {}

  public async upload(photo: LocalPhotoMetadata, cached: CachedPhotoBlob): Promise<void> {
    const response = await this.fetcher(`${this.basePath}/photos/${photo.id}/upload`, {
      method: "PUT",
      headers: {
        "content-type": cached.blob.type,
        "x-client-mutation-id": cached.uploadMutationId,
      },
      body: cached.blob,
      credentials: "include",
    });
    if (!response.ok) throw new Error("사진 업로드를 완료하지 못했습니다.");
  }
}

export interface PhotoContext {
  property: Pick<LocalProperty, "id">;
  room: Pick<LocalRoom, "id" | "name">;
  checklistItem: { id: ClientId; label: string; elementId: ClientId | null };
  note?: string | null;
}

export interface QueuedPhoto {
  photo: LocalPhotoMetadata;
  cached: CachedPhotoBlob;
}

function normalizedPhotoNote(note: string | null | undefined): string | null {
  const normalized = note?.trim() ?? "";
  if (normalized.length > 4_000) throw new Error("사진 메모는 4,000자 이하로 입력하세요.");
  return normalized || null;
}

function photoMetadata(
  context: PhotoContext,
  compressed: CompressedPhoto,
  photoId: ClientId,
  uploadMutationId: ClientMutationId,
): LocalPhotoMetadata {
  const timestamp = Date.now();
  return {
    id: photoId,
    propertyId: context.property.id,
    roomId: context.room.id,
    elementId: context.checklistItem.elementId,
    checklistItemId: context.checklistItem.id,
    r2Key: photoObjectKey(context.property.id, photoId, compressed.mimeType),
    mimeType: compressed.mimeType,
    width: compressed.width,
    height: compressed.height,
    note: context.note?.trim() || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    dirty: false,
    uploadStatus: "pending",
    uploadMutationId,
    uploadAttempts: 0,
    uploadError: null,
  };
}

function metadataOperation(photo: LocalPhotoMetadata) {
  const clientMutationId = newClientId("mutation");
  return {
    clientMutationId,
    method: "POST" as const,
    path: "/photos",
    body: {
      clientMutationId,
      data: {
        id: photo.id,
        propertyId: photo.propertyId,
        roomId: photo.roomId,
        elementId: photo.elementId,
        checklistItemId: photo.checklistItemId,
        r2Key: photo.r2Key,
        mimeType: photo.mimeType,
        width: photo.width,
        height: photo.height,
        note: photo.note,
      },
    },
  };
}

/**
 * Serializes binary retries independently of the JSON sync queue. The Blob is
 * only deleted after the Worker confirms R2 write and D1 upload state update.
 */
export class PhotoUploadQueue {
  private processing: Promise<void> | null = null;
  private readonly onlineHandler: () => void;

  public constructor(
    private readonly repository: LocalFirstRepository,
    private readonly uploader: PhotoUploadClient,
    private readonly compressor: PhotoCompressionAdapter | undefined = undefined,
    private readonly onlineTarget: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
  ) {
    this.onlineHandler = () => { void this.process(); };
    this.onlineTarget?.addEventListener("online", this.onlineHandler);
  }

  public dispose(): void {
    this.onlineTarget?.removeEventListener("online", this.onlineHandler);
  }

  public async enqueue(file: Blob, context: PhotoContext): Promise<LocalPhotoMetadata> {
    const note = normalizedPhotoNote(context.note);
    const compressed = await compressPhoto(file, this.compressor);
    const photoId = newClientId("photo");
    const uploadMutationId = newClientId("upload");
    const photo = photoMetadata({ ...context, note }, compressed, photoId, uploadMutationId);
    const cached: CachedPhotoBlob = { photoId, blob: compressed.blob, uploadMutationId, createdAt: Date.now() };

    // The binary cache is intentionally committed before the JSON mutation is
    // eligible to flush, so a successful metadata POST can never outlive its retry Blob.
    await this.repository.db.photoBlobs.put(cached);
    try {
      await this.repository.persistOptimisticChange({ entityKind: "photo", entity: photo, operation: metadataOperation(photo) });
    } catch (error) {
      await this.repository.db.photoBlobs.delete(photoId);
      throw error;
    }
    void this.process();
    return photo;
  }

  public async process(): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = this.processPending().finally(() => { this.processing = null; });
    return this.processing;
  }

  private async processPending(): Promise<void> {
    await this.repository.flush();
    const cachedPhotos = await this.repository.db.photoBlobs.toArray();
    for (const cached of cachedPhotos) {
      const photo = await this.repository.db.photoMetadata.get(cached.photoId);
      // The metadata POST must be acknowledged before a binary write is attempted.
      if (!photo || photo.dirty) continue;
      await this.repository.updatePhotoUploadState(photo.id, {
        uploadStatus: "uploading",
        uploadAttempts: photo.uploadAttempts,
        uploadError: null,
      });
      try {
        await this.uploader.upload(photo, cached);
        await this.repository.db.transaction("rw", this.repository.db.photoBlobs, this.repository.db.photoMetadata, async () => {
          await this.repository.db.photoBlobs.delete(photo.id);
          const current = await this.repository.db.photoMetadata.get(photo.id);
          if (current) {
            await this.repository.db.photoMetadata.put({
              ...current,
              uploadStatus: "uploaded",
              uploadError: null,
              updatedAt: Date.now(),
            });
          }
        });
        const uploaded = await this.repository.db.photoMetadata.get(photo.id);
        if (uploaded) this.repository.store.setState((state) => ({ photoMetadata: { ...state.photoMetadata, [uploaded.id]: uploaded } }));
      } catch {
        await this.repository.updatePhotoUploadState(photo.id, {
          uploadStatus: "failed",
          uploadAttempts: photo.uploadAttempts + 1,
          uploadError: "업로드가 보류되었습니다. 인터넷 연결 후 다시 시도합니다.",
        });
      }
    }
  }
}
