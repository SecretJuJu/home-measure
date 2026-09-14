import type { ClientId, ClientMutationId } from "@home-measure/domain";

import type {
  LocalChecklistItem,
  LocalEntityKind,
  LocalMeasurement,
  LocalPhotoMetadata,
  LocalProperty,
  LocalRoom,
  QueuedOperation,
} from "./entities";

/**
 * The request that would put an entity on the server from scratch.
 *
 * The queue can outlive the server's copy of a record: a device edits a plan while signed out, the
 * account it first synced under is gone, or the row was deleted elsewhere. Every later update then
 * answers 404 forever. Rebuilding the create from what the device still holds turns that dead end
 * back into an upload instead of stranding the measurements.
 */
export type RestoreOperation = Omit<QueuedOperation, "createdAt" | "attempts" | "sequence">;

export function createOperation(
  kind: LocalEntityKind,
  entity: LocalProperty | LocalRoom | LocalChecklistItem | LocalMeasurement | LocalPhotoMetadata,
  clientMutationId: ClientMutationId,
): RestoreOperation {
  switch (kind) {
    case "property": {
      const property = entity as LocalProperty;
      return operation(clientMutationId, "property", "POST", "/properties", property.id, property.id, {
        id: property.id,
        name: property.name,
        address: property.address,
        note: property.note,
      });
    }
    case "room": {
      const room = entity as LocalRoom;
      return operation(clientMutationId, "room", "POST", `/properties/${room.propertyId}/rooms`, room.id, room.propertyId, {
        id: room.id,
        name: room.name,
        type: room.type,
        layout: room.layout,
      });
    }
    case "checklist": {
      const item = entity as LocalChecklistItem;
      return operation(clientMutationId, "checklist", "POST", "/checklist", item.id, item.propertyId, {
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
      });
    }
    case "measurement": {
      const measurement = entity as LocalMeasurement;
      return operation(clientMutationId, "measurement", "POST", "/measurements", measurement.id, measurement.propertyId, {
        id: measurement.id,
        propertyId: measurement.propertyId,
        roomId: measurement.roomId,
        elementId: measurement.elementId,
        checklistItemId: measurement.checklistItemId,
        type: measurement.type,
        value: measurement.value,
        unit: measurement.unit,
        note: measurement.note,
      });
    }
    case "photo": {
      const photo = entity as LocalPhotoMetadata;
      return operation(clientMutationId, "photo", "POST", "/photos", photo.id, photo.propertyId, {
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
      });
    }
  }
}

/** The entity a create depends on, so a missing parent is restored before its child. */
export function parentOf(kind: LocalEntityKind): LocalEntityKind | null {
  return kind === "property" ? null : "property";
}

function operation(
  clientMutationId: ClientMutationId,
  entityKind: LocalEntityKind,
  method: QueuedOperation["method"],
  path: string,
  entityId: ClientId,
  propertyId: ClientId,
  data: Record<string, unknown>,
): RestoreOperation {
  return { clientMutationId, entityKind, entityId, propertyId, method, path, body: { clientMutationId, data } };
}
