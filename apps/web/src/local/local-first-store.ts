import { clientMutationIdSchema, type ClientId, type ClientMutationId } from "@home-measure/domain";
import type { Table } from "dexie";
import { createStore, type StoreApi } from "zustand/vanilla";

import { ApiRequestError, type ApiClient } from "./api-client";
import { HomeMeasureDatabase } from "./database";
import { createOperation, parentOf } from "./recovery";
import type {
  LocalChecklistItem,
  LocalEntity,
  LocalEntityForKind,
  LocalEntityKind,
  LocalMeasurement,
  LocalPhotoMetadata,
  LocalProperty,
  LocalRoom,
  OptimisticDeletion,
  OptimisticChange,
  QueuedOperation,
} from "./entities";

export type SyncStatus = "idle" | "syncing" | "offline" | "signed-out" | "error";

export interface LocalFirstState {
  hydrated: boolean;
  syncStatus: SyncStatus;
  lastSyncError: string | undefined;
  pendingOperationCount: number;
  properties: Record<string, LocalProperty>;
  rooms: Record<string, LocalRoom>;
  checklistItems: Record<string, LocalChecklistItem>;
  measurements: Record<string, LocalMeasurement>;
  photoMetadata: Record<string, LocalPhotoMetadata>;
}

const initialState: LocalFirstState = {
  hydrated: false,
  syncStatus: "idle",
  lastSyncError: undefined,
  pendingOperationCount: 0,
  properties: {},
  rooms: {},
  checklistItems: {},
  measurements: {},
  photoMetadata: {},
};

type EntityCollectionName = "properties" | "rooms" | "checklistItems" | "measurements" | "photoMetadata";

function collectionFor(kind: LocalEntityKind): EntityCollectionName {
  switch (kind) {
    case "property": return "properties";
    case "room": return "rooms";
    case "checklist": return "checklistItems";
    case "measurement": return "measurements";
    case "photo": return "photoMetadata";
  }
}

function databaseTableFor(db: HomeMeasureDatabase, kind: LocalEntityKind): Table<LocalEntity, ClientId> {
  switch (kind) {
    case "property": return db.properties as unknown as Table<LocalEntity, ClientId>;
    case "room": return db.rooms as unknown as Table<LocalEntity, ClientId>;
    case "checklist": return db.checklistItems as unknown as Table<LocalEntity, ClientId>;
    case "measurement": return db.measurements as unknown as Table<LocalEntity, ClientId>;
    case "photo": return db.photoMetadata as unknown as Table<LocalEntity, ClientId>;
  }
}

function mergeEntities<T extends LocalEntity>(persisted: T[], current: Record<string, T>): Record<string, T> {
  const merged = { ...current };
  for (const entity of persisted) {
    const active = merged[entity.id];
    if (!active || (!active.dirty && (entity.dirty || entity.updatedAt >= active.updatedAt))) {
      merged[entity.id] = entity;
    }
  }
  return merged;
}

function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to synchronize local changes";
}

/** A 404 on a queued write means the record is not on the server, not that the request was wrong. */
function isMissingOnServerError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

function newMutationId(): ClientMutationId {
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `mutation_${entropy}` as ClientMutationId;
}

function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
}

/** A rejected session is not a failure to fix but a sign-in the person has not done yet. */
function isSignedOutError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

export class LocalFirstRepository {
  public readonly store: StoreApi<LocalFirstState>;
  private flushPromise: Promise<void> | null = null;
  private readonly reconnectHandler: () => void;
  private readonly reconnectTarget: Pick<Window, "addEventListener" | "removeEventListener"> | undefined;

  public constructor(
    public readonly db: HomeMeasureDatabase,
    private readonly apiClient: ApiClient,
    reconnectTarget: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
  ) {
    this.store = createStore<LocalFirstState>(() => initialState);
    this.reconnectHandler = () => { void this.flush(); };
    this.reconnectTarget = reconnectTarget;
    this.reconnectTarget?.addEventListener("online", this.reconnectHandler);
  }

  public dispose(): void {
    this.reconnectTarget?.removeEventListener("online", this.reconnectHandler);
  }

  public async rehydrate(): Promise<void> {
    const [properties, rooms, checklistItems, measurements, photoMetadata, operations] = await Promise.all([
      this.db.properties.toArray(),
      this.db.rooms.toArray(),
      this.db.checklistItems.toArray(),
      this.db.measurements.toArray(),
      this.db.photoMetadata.toArray(),
      this.db.operations.count(),
    ]);
    this.store.setState((current) => ({
      hydrated: true,
      pendingOperationCount: operations,
      properties: mergeEntities(properties, current.properties),
      rooms: mergeEntities(rooms, current.rooms),
      checklistItems: mergeEntities(checklistItems, current.checklistItems),
      measurements: mergeEntities(measurements, current.measurements),
      photoMetadata: mergeEntities(photoMetadata, current.photoMetadata),
    }));
  }

  /**
   * Applies the user edit immediately, persists the entity and its envelope atomically,
   * then starts a best-effort sync. The mutation body is never regenerated on retry.
   */
  public async persistOptimisticChange<K extends LocalEntityKind>(change: OptimisticChange<K>): Promise<void> {
    const parsedMutationId = clientMutationIdSchema.safeParse(change.operation.clientMutationId);
    if (!parsedMutationId.success) throw new Error("Invalid client mutation ID");
    if (change.operation.body.clientMutationId !== change.operation.clientMutationId) {
      throw new Error("Queued mutation body must preserve its clientMutationId");
    }

    const timestamp = Date.now();
    const entity = {
      ...change.entity,
      dirty: true,
      lastMutationId: parsedMutationId.data,
      updatedAt: timestamp,
    } as LocalEntityForKind<K>;
    const operation: QueuedOperation = {
      ...change.operation,
      clientMutationId: parsedMutationId.data,
      entityId: entity.id,
      entityKind: change.entityKind,
      propertyId: this.propertyIdFor(change.entityKind, entity),
      createdAt: timestamp,
      attempts: 0,
      sequence: 0,
    };

    this.applyEntityToState(change.entityKind, entity);
    const table = databaseTableFor(this.db, change.entityKind);
    await this.db.transaction("rw", table, this.db.operations, async () => {
      const existing = await this.db.operations.get(operation.clientMutationId);
      if (existing) return;
      await table.put(entity);
      // A full-replacement write supersedes an earlier one for the same target that never left the
      // device, so editing a plan offline queues one upload rather than one per nudge.
      if (operation.method === "PUT") {
        const superseded = await this.db.operations
          .filter((queued) => queued.method === "PUT" && queued.path === operation.path && queued.attempts === 0)
          .toArray();
        await this.db.operations.bulkDelete(superseded.map((queued) => queued.clientMutationId));
      }
      const previous = await this.db.operations.orderBy("sequence").last();
      await this.db.operations.add({ ...operation, sequence: (previous?.sequence ?? 0) + 1 });
    });
    this.store.setState({ pendingOperationCount: await this.db.operations.count() });
    void this.flush();
  }

  /**
   * Removes an entity from local state first and queues one durable DELETE.
   * Earlier writes for the removed entity (and its local children) are dropped
   * so an offline create/update cannot be replayed after its deletion.
   */
  public async persistOptimisticDeletion(deletion: OptimisticDeletion): Promise<void> {
    const parsedMutationId = clientMutationIdSchema.safeParse(deletion.operation.clientMutationId);
    if (!parsedMutationId.success) throw new Error("Invalid client mutation ID");
    if (deletion.operation.method !== "DELETE" || deletion.operation.body.clientMutationId !== deletion.operation.clientMutationId) {
      throw new Error("Queued deletion must preserve a DELETE mutation envelope");
    }

    const operation: QueuedOperation = {
      ...deletion.operation,
      clientMutationId: parsedMutationId.data,
      entityId: deletion.entityId,
      entityKind: deletion.entityKind,
      propertyId: deletion.propertyId,
      createdAt: Date.now(),
      attempts: 0,
      sequence: 0,
    };
    const tables = [
      this.db.properties,
      this.db.rooms,
      this.db.checklistItems,
      this.db.measurements,
      this.db.photoMetadata,
      this.db.operations,
    ] as const;
    let deletedPhotoIds: ClientId[] = [];

    await this.db.transaction("rw", tables, async () => {
      const existing = await this.db.operations.get(operation.clientMutationId);
      if (existing) return;

      const roomIds = deletion.entityKind === "property"
        ? (await this.db.rooms.where("propertyId").equals(deletion.propertyId).primaryKeys())
        : [deletion.entityId];
      const roomIdSet = new Set(roomIds);
      const checklistIds = new Set((await this.db.checklistItems.where("propertyId").equals(deletion.propertyId).toArray())
        .filter((item) => deletion.entityKind === "property" || (item.roomId !== null && roomIdSet.has(item.roomId)))
        .map((item) => item.id));
      const measurementIds = new Set((await this.db.measurements.where("propertyId").equals(deletion.propertyId).toArray())
        .filter((item) => deletion.entityKind === "property" || (item.roomId !== null && roomIdSet.has(item.roomId)))
        .map((item) => item.id));
      const photos = (await this.db.photoMetadata.where("propertyId").equals(deletion.propertyId).toArray())
        .filter((item) => deletion.entityKind === "property" || (item.roomId !== null && roomIdSet.has(item.roomId)));
      const photoIds = new Set(photos.map((item) => item.id));
      deletedPhotoIds = [...photoIds];
      const deletedEntityIds = new Set<ClientId>([
        deletion.entityId,
        ...roomIds,
        ...checklistIds,
        ...measurementIds,
        ...photoIds,
      ]);

      await this.db.operations.filter((queued) => deletedEntityIds.has(queued.entityId)).delete();
      if (deletion.entityKind === "property") {
        await this.db.properties.delete(deletion.entityId);
        await this.db.rooms.where("propertyId").equals(deletion.propertyId).delete();
      } else {
        await this.db.rooms.delete(deletion.entityId);
      }
      await this.db.checklistItems.bulkDelete([...checklistIds]);
      await this.db.measurements.bulkDelete([...measurementIds]);
      await this.db.photoMetadata.bulkDelete([...photoIds]);

      const previous = await this.db.operations.orderBy("sequence").last();
      await this.db.operations.add({ ...operation, sequence: (previous?.sequence ?? 0) + 1 });
    });
    await this.db.photoBlobs.bulkDelete(deletedPhotoIds);
    this.removeDeletedEntitiesFromState(deletion.entityKind, deletion.entityId, deletion.propertyId);
    this.store.setState({ pendingOperationCount: await this.db.operations.count() });
    void this.flush();
  }

  public async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPendingOperations().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  /**
   * Updates device-only photo transfer state without creating another metadata
   * mutation. In particular, an R2 retry must not regenerate the original
   * stable POST /photos envelope.
   */
  public async updatePhotoUploadState(
    photoId: ClientId,
    update: Pick<LocalPhotoMetadata, "uploadStatus" | "uploadAttempts" | "uploadError">,
  ): Promise<void> {
    const current = await this.db.photoMetadata.get(photoId);
    if (!current) return;
    const updated: LocalPhotoMetadata = { ...current, ...update, updatedAt: Date.now() };
    await this.db.photoMetadata.put(updated);
    this.applyEntityToState("photo", updated);
  }

  private async flushPendingOperations(): Promise<void> {
    const restored = new Set<ClientId>();
    while (true) {
      const operation = await this.db.operations.orderBy("sequence").first();
      if (!operation) {
        this.store.setState({ syncStatus: "idle", lastSyncError: undefined, pendingOperationCount: 0 });
        return;
      }
      this.store.setState({
        syncStatus: "syncing",
        lastSyncError: undefined,
        pendingOperationCount: await this.db.operations.count(),
      });
      try {
        await this.apiClient.send(operation);
      } catch (error) {
        if (isMissingOnServerError(error) && await this.repairMissingEntity(operation, restored)) continue;
        const message = syncErrorMessage(error);
        await this.db.operations.update(operation.clientMutationId, {
          attempts: operation.attempts + 1,
          lastError: message,
        });
        this.store.setState({
          syncStatus: isOfflineError(error) ? "offline" : isSignedOutError(error) ? "signed-out" : "error",
          lastSyncError: message,
          pendingOperationCount: await this.db.operations.count(),
        });
        return;
      }

      await this.acknowledgeOperation(operation);
    }
  }

  /**
   * The server does not have this record, so no retry of an update can ever land. Replace the dead
   * operation with the create built from what the device still holds, restoring the parent first
   * when that is missing too. A delete of an absent record has already got what it wanted.
   */
  private async repairMissingEntity(operation: QueuedOperation, restored: Set<ClientId>): Promise<boolean> {
    if (operation.method === "DELETE") {
      await this.db.operations.delete(operation.clientMutationId);
      this.store.setState({ pendingOperationCount: await this.db.operations.count() });
      return true;
    }
    const missing = operation.method === "POST" ? parentOf(operation.entityKind) : operation.entityKind;
    if (!missing) return false;
    const entityId = missing === operation.entityKind ? operation.entityId : operation.propertyId;
    if (restored.has(entityId)) return false;
    const entity = await databaseTableFor(this.db, missing).get(entityId);
    if (!entity) return false;
    restored.add(entityId);
    const replacement = createOperation(missing, entity, newMutationId());
    await this.db.transaction("rw", this.db.operations, async () => {
      // Take the failing slot when the entity itself is missing; sit in front of it for a parent.
      const sequence = missing === operation.entityKind ? operation.sequence : operation.sequence - 0.5;
      if (missing === operation.entityKind) await this.db.operations.delete(operation.clientMutationId);
      await this.db.operations.add({ ...replacement, createdAt: Date.now(), attempts: 0, sequence });
    });
    this.store.setState({ pendingOperationCount: await this.db.operations.count() });
    return true;
  }

  private async acknowledgeOperation(operation: QueuedOperation): Promise<void> {
    const table = databaseTableFor(this.db, operation.entityKind);
    await this.db.transaction("rw", table, this.db.operations, async () => {
      const currentEntity = await table.get(operation.entityId);
      if (currentEntity?.lastMutationId === operation.clientMutationId) {
        await table.put({ ...currentEntity, dirty: false, lastMutationId: undefined });
        this.clearDirtyInState(operation.entityKind, operation.entityId, operation.clientMutationId);
      }
      await this.db.operations.delete(operation.clientMutationId);
    });
    this.store.setState({ pendingOperationCount: await this.db.operations.count() });
  }

  private propertyIdFor<K extends LocalEntityKind>(kind: K, entity: LocalEntityForKind<K>): ClientId {
    return kind === "property"
      ? entity.id
      : (entity as Exclude<LocalEntity, LocalProperty>).propertyId;
  }

  private applyEntityToState<K extends LocalEntityKind>(kind: K, entity: LocalEntityForKind<K>): void {
    const collection = collectionFor(kind);
    this.store.setState((current) => ({
      [collection]: { ...current[collection], [entity.id]: entity },
    }) as Partial<LocalFirstState>);
  }

  private clearDirtyInState(kind: LocalEntityKind, entityId: ClientId, mutationId: ClientMutationId): void {
    const collection = collectionFor(kind);
    this.store.setState((current) => {
      const entity = current[collection][entityId];
      if (!entity || entity.lastMutationId !== mutationId) return {};
      return {
        [collection]: {
          ...current[collection],
          [entityId]: { ...entity, dirty: false, lastMutationId: undefined },
        },
      } as Partial<LocalFirstState>;
    });
  }

  private removeDeletedEntitiesFromState(
    kind: OptimisticDeletion["entityKind"],
    entityId: ClientId,
    propertyId: ClientId,
  ): void {
    this.store.setState((current) => {
      const belongsToDeletedRoom = <T extends { roomId: ClientId | null }>(entity: T) => kind === "room" && entity.roomId === entityId;
      const removeProperty = kind === "property";
      const rooms = Object.fromEntries(Object.entries(current.rooms).filter(([, room]) => !removeProperty ? room.id !== entityId : room.propertyId !== propertyId));
      const checklistItems = Object.fromEntries(Object.entries(current.checklistItems).filter(([, item]) => !(removeProperty ? item.propertyId === propertyId : belongsToDeletedRoom(item))));
      const measurements = Object.fromEntries(Object.entries(current.measurements).filter(([, item]) => !(removeProperty ? item.propertyId === propertyId : belongsToDeletedRoom(item))));
      const photoMetadata = Object.fromEntries(Object.entries(current.photoMetadata).filter(([, item]) => !(removeProperty ? item.propertyId === propertyId : belongsToDeletedRoom(item))));
      const properties = removeProperty
        ? Object.fromEntries(Object.entries(current.properties).filter(([id]) => id !== entityId))
        : current.properties;
      return { properties, rooms, checklistItems, measurements, photoMetadata };
    });
  }
}

export function createLocalFirstRepository(db: HomeMeasureDatabase, apiClient: ApiClient): LocalFirstRepository {
  return new LocalFirstRepository(db, apiClient);
}
