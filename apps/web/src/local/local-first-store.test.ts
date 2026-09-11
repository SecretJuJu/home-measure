import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "./api-client";
import { HomeMeasureDatabase } from "./database";
import { LocalFirstRepository } from "./local-first-store";
import type { LocalChecklistItem, LocalMeasurement, LocalProperty, LocalRoom, QueuedOperation } from "./entities";

const propertyId = "property_0001";
const measurementId = "measure_00001";

function createProperty(overrides: Partial<LocalProperty> = {}): LocalProperty {
  return {
    id: propertyId,
    name: "우리 집",
    address: null,
    note: null,
    createdAt: 1,
    updatedAt: 1,
    dirty: false,
    ...overrides,
  };
}

function createMeasurement(overrides: Partial<LocalMeasurement> = {}): LocalMeasurement {
  return {
    id: measurementId,
    propertyId,
    roomId: null,
    elementId: null,
    checklistItemId: null,
    type: "width",
    value: 3200,
    unit: "mm",
    note: null,
    createdAt: 1,
    updatedAt: 1,
    dirty: false,
    ...overrides,
  };
}

function createRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: "room_00001",
    propertyId,
    name: "거실",
    type: "living_room",
    layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 4_000, height: 3_000 }, doors: [], windows: [], utilities: [] },
    createdAt: 1,
    updatedAt: 1,
    dirty: false,
    ...overrides,
  };
}

function createChecklist(overrides: Partial<LocalChecklistItem> = {}): LocalChecklistItem {
  return {
    id: "checklist_0001",
    propertyId,
    roomId: "room_00001",
    elementId: null,
    label: "거실 폭",
    category: "dimension",
    required: true,
    status: "pending",
    measurementId: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    dirty: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw error;
}

describe("LocalFirstRepository", () => {
  let db: HomeMeasureDatabase;
  let repository: LocalFirstRepository;

  afterEach(async () => {
    repository?.dispose();
    await db?.delete();
  });

  it("persists an optimistic edit and its unchanged envelope before HTTP acknowledgement", async () => {
    const request = deferred<void>();
    const sent: QueuedOperation[] = [];
    const api: ApiClient = {
      send: async (operation) => {
        sent.push(operation);
        return request.promise;
      },
    };
    db = new HomeMeasureDatabase(`optimistic-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, api, undefined);
    const envelope = {
      clientMutationId: "mutation_0001",
      data: { id: propertyId, name: "우리 집", address: null, note: null },
    };

    await repository.persistOptimisticChange({
      entityKind: "property",
      entity: createProperty(),
      operation: { clientMutationId: "mutation_0001", method: "POST", path: "/properties", body: envelope },
    });

    const saved = await db.properties.get(propertyId);
    const queued = await db.operations.get("mutation_0001");
    expect(saved?.dirty).toBe(true);
    expect(saved?.lastMutationId).toBe("mutation_0001");
    expect(queued?.body).toEqual(envelope);
    expect(repository.store.getState().properties[propertyId]?.dirty).toBe(true);
    await eventually(() => expect(sent).toHaveLength(1));

    request.resolve();
    await eventually(() => expect(repository.store.getState().pendingOperationCount).toBe(0));
    expect((await db.properties.get(propertyId))?.dirty).toBe(false);
  });

  it("retains an offline measurement and retries the same mutation safely", async () => {
    let calls = 0;
    const sentMutationIds: string[] = [];
    const api: ApiClient = {
      send: async (operation) => {
        calls += 1;
        sentMutationIds.push(operation.clientMutationId);
        if (calls === 1) throw new TypeError("network unavailable");
      },
    };
    db = new HomeMeasureDatabase(`retry-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, api, undefined);
    const envelope = {
      clientMutationId: "mutation_0002",
      data: {
        id: measurementId,
        propertyId,
        roomId: null,
        elementId: null,
        checklistItemId: null,
        type: "width",
        value: 3200,
        unit: "mm",
        note: null,
      },
    };

    await repository.persistOptimisticChange({
      entityKind: "measurement",
      entity: createMeasurement(),
      operation: { clientMutationId: "mutation_0002", method: "POST", path: "/measurements", body: envelope },
    });

    await eventually(() => expect(repository.store.getState().syncStatus).toBe("offline"));
    expect((await db.measurements.get(measurementId))?.dirty).toBe(true);
    expect((await db.operations.get("mutation_0002"))?.attempts).toBe(1);

    await repository.flush();
    expect(sentMutationIds).toEqual(["mutation_0002", "mutation_0002"]);
    expect(await db.operations.count()).toBe(0);
    expect((await db.measurements.get(measurementId))?.dirty).toBe(false);
  });

  it("rehydrates persisted entities without replacing a newer dirty in-memory edit", async () => {
    const api: ApiClient = { send: async () => undefined };
    db = new HomeMeasureDatabase(`rehydrate-${crypto.randomUUID()}`);
    await db.properties.put(createProperty({ name: "IndexedDB 이름", updatedAt: 10 }));
    await db.measurements.put(createMeasurement({ dirty: true, lastMutationId: "mutation_0003", updatedAt: 10 }));
    repository = new LocalFirstRepository(db, api, undefined);
    repository.store.setState({
      properties: {
        [propertyId]: createProperty({
          name: "메모리에 남은 오프라인 편집",
          dirty: true,
          lastMutationId: "mutation_0004",
          updatedAt: 20,
        }),
      },
    });

    await repository.rehydrate();

    expect(repository.store.getState().properties[propertyId]?.name).toBe("메모리에 남은 오프라인 편집");
    expect(repository.store.getState().measurements[measurementId]?.value).toBe(3200);
    expect(repository.store.getState().measurements[measurementId]?.dirty).toBe(true);
    expect(repository.store.getState().hydrated).toBe(true);
  });

  it("locally removes a property and children while retaining one stable DELETE tombstone", async () => {
    const request = deferred<void>();
    const sent: QueuedOperation[] = [];
    const api: ApiClient = { send: async (operation) => { sent.push(operation); return request.promise; } };
    db = new HomeMeasureDatabase(`delete-${crypto.randomUUID()}`);
    await db.properties.put(createProperty());
    await db.rooms.put(createRoom());
    await db.checklistItems.put(createChecklist());
    await db.measurements.put(createMeasurement({ roomId: "room_00001", checklistItemId: "checklist_0001" }));
    repository = new LocalFirstRepository(db, api, undefined);
    await repository.rehydrate();

    await repository.persistOptimisticDeletion({
      entityKind: "property",
      entityId: propertyId,
      propertyId,
      operation: {
        clientMutationId: "mutation_delete_0001",
        method: "DELETE",
        path: `/properties/${propertyId}`,
        body: { clientMutationId: "mutation_delete_0001", data: {} },
      },
    });

    expect(await db.properties.get(propertyId)).toBeUndefined();
    expect(await db.rooms.get("room_00001")).toBeUndefined();
    expect(await db.checklistItems.get("checklist_0001")).toBeUndefined();
    expect(await db.measurements.get(measurementId)).toBeUndefined();
    expect(repository.store.getState().properties[propertyId]).toBeUndefined();
    await eventually(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", path: `/properties/${propertyId}`, body: { clientMutationId: "mutation_delete_0001", data: {} } });

    request.resolve();
    await eventually(() => expect(repository.store.getState().pendingOperationCount).toBe(0));
  });
});
