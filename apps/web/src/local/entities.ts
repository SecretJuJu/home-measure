import type {
  ChecklistCreate,
  ClientId,
  ClientMutationId,
  MeasurementCreate,
  PhotoCreate,
  PropertyCreate,
  RoomCreate,
} from "@home-measure/domain";

export type LocalEntityKind = "property" | "room" | "checklist" | "measurement" | "photo";

export interface LocalSyncFields {
  dirty: boolean;
  /** The latest write that changed this entity. It prevents an older ack clearing newer work. */
  lastMutationId?: ClientMutationId | undefined;
  updatedAt: number;
}

export interface LocalProperty extends PropertyCreate, LocalSyncFields {
  address: string | null;
  note: string | null;
  createdAt: number;
}

export interface LocalRoom extends RoomCreate, LocalSyncFields {
  propertyId: ClientId;
  createdAt: number;
}

export interface LocalChecklistItem extends ChecklistCreate, LocalSyncFields {
  roomId: ClientId | null;
  elementId: ClientId | null;
  category: ChecklistCreate["category"] | null;
  measurementId: ClientId | null;
  createdAt: number;
}

export interface LocalMeasurement extends MeasurementCreate, LocalSyncFields {
  roomId: ClientId | null;
  elementId: ClientId | null;
  checklistItemId: ClientId | null;
  value: number | null;
  note: string | null;
  createdAt: number;
}

/** Metadata only: image blobs/base64 are deliberately not stored in the sync model. */
export interface LocalPhotoMetadata extends PhotoCreate, LocalSyncFields {
  roomId: ClientId | null;
  elementId: ClientId | null;
  checklistItemId: ClientId | null;
  width: number | null;
  height: number | null;
  note: string | null;
  createdAt: number;
  /** Upload lifecycle is local-only; the D1 metadata row is not proof that R2 has the image. */
  uploadStatus: PhotoUploadStatus;
  uploadMutationId: ClientMutationId;
  uploadAttempts: number;
  uploadError: string | null;
}

export type PhotoUploadStatus = "pending" | "uploading" | "uploaded" | "failed";

/**
 * Kept in a separate IndexedDB table so binary image data never enters a sync
 * entity, queued JSON payload, or D1 metadata record.
 */
export interface CachedPhotoBlob {
  photoId: ClientId;
  blob: Blob;
  uploadMutationId: ClientMutationId;
  createdAt: number;
}

export type LocalEntity =
  | LocalProperty
  | LocalRoom
  | LocalChecklistItem
  | LocalMeasurement
  | LocalPhotoMetadata;

export type LocalEntityForKind<K extends LocalEntityKind> =
  K extends "property" ? LocalProperty
    : K extends "room" ? LocalRoom
      : K extends "checklist" ? LocalChecklistItem
        : K extends "measurement" ? LocalMeasurement
          : LocalPhotoMetadata;

export type SyncHttpMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface QueuedOperation {
  clientMutationId: ClientMutationId;
  entityId: ClientId;
  entityKind: LocalEntityKind;
  propertyId: ClientId;
  method: SyncHttpMethod;
  path: string;
  /** The shared domain mutation envelope, persisted and retried without modification. */
  body: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /** Monotonic queue order, allocated inside the IndexedDB transaction. */
  sequence: number;
}

export interface OptimisticChange<K extends LocalEntityKind = LocalEntityKind> {
  entityKind: K;
  entity: LocalEntityForKind<K>;
  operation: Omit<QueuedOperation, "entityId" | "entityKind" | "propertyId" | "createdAt" | "attempts" | "sequence">;
}

/**
 * A local deletion removes the visible entity immediately, while its stable
 * DELETE envelope remains durable until the server acknowledges it.
 */
export interface OptimisticDeletion {
  entityKind: "property" | "room";
  entityId: ClientId;
  propertyId: ClientId;
  operation: Omit<QueuedOperation, "entityId" | "entityKind" | "propertyId" | "createdAt" | "attempts" | "sequence">;
}
