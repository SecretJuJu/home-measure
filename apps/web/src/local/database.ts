import Dexie, { type EntityTable } from "dexie";

import type {
  LocalChecklistItem,
  CachedPhotoBlob,
  LocalMeasurement,
  LocalPhotoMetadata,
  LocalProperty,
  LocalRoom,
  QueuedOperation,
} from "./entities";

export class HomeMeasureDatabase extends Dexie {
  properties!: EntityTable<LocalProperty, "id">;
  rooms!: EntityTable<LocalRoom, "id">;
  checklistItems!: EntityTable<LocalChecklistItem, "id">;
  measurements!: EntityTable<LocalMeasurement, "id">;
  photoMetadata!: EntityTable<LocalPhotoMetadata, "id">;
  photoBlobs!: EntityTable<CachedPhotoBlob, "photoId">;
  operations!: EntityTable<QueuedOperation, "clientMutationId">;

  public constructor(name = "home-measure") {
    super(name);
    this.version(1).stores({
      properties: "id, dirty, updatedAt",
      rooms: "id, propertyId, dirty, updatedAt",
      checklistItems: "id, propertyId, roomId, dirty, updatedAt",
      measurements: "id, propertyId, roomId, dirty, updatedAt",
      photoMetadata: "id, propertyId, roomId, dirty, updatedAt",
      operations: "clientMutationId, sequence, propertyId, entityId, [propertyId+sequence], [entityId+sequence]",
    });
    this.version(2).stores({
      properties: "id, dirty, updatedAt",
      rooms: "id, propertyId, dirty, updatedAt",
      checklistItems: "id, propertyId, roomId, dirty, updatedAt",
      measurements: "id, propertyId, roomId, dirty, updatedAt",
      photoMetadata: "id, propertyId, roomId, dirty, updatedAt",
      photoBlobs: "photoId, createdAt",
      operations: "clientMutationId, sequence, propertyId, entityId, [propertyId+sequence], [entityId+sequence]",
    });
  }
}
