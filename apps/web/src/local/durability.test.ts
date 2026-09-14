// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { parseRoomLayout } from "@home-measure/domain";
import { afterEach, describe, expect, it } from "vitest";

import { ApiRequestError } from "./api-client";
import { HomeMeasureDatabase, LocalFirstRepository } from "./index";
import type { LocalProperty, LocalRoom } from "./entities";

let opened: HomeMeasureDatabase[] = [];

function open(name: string): HomeMeasureDatabase {
  const db = new HomeMeasureDatabase(name);
  opened.push(db);
  return db;
}

afterEach(async () => {
  for (const db of opened) {
    await db.delete();
    db.close();
  }
  opened = [];
});

/**
 * The field data on a device is the only copy until someone signs in, so every release has to open
 * what the previous one wrote. These tests stand in for that upgrade.
 */
describe("stored measurements survive a new release", () => {
  it("reopens a database written before the app gained a feature, with the records intact", async () => {
    // #given
    const name = `durability-${crypto.randomUUID()}`;
    const property: LocalProperty = { id: "property_0001", name: "성수동 새집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: true };
    const room: LocalRoom = {
      id: "room_0001",
      propertyId: property.id,
      name: "거실",
      type: "living_room",
      // A layout from before notches and utility footprints existed.
      layout: { version: 1, position: { x: 900, y: 900 }, size: { width: 4_400, height: 3_300 }, doors: [], windows: [], utilities: [{ id: "utility_0001", type: "outlet", position: { x: 1_200, y: 1_000 } }] },
      createdAt: 1,
      updatedAt: 1,
      dirty: true,
    };
    const first = open(name);
    await first.properties.put(property);
    await first.rooms.put(room);
    first.close();

    // #when
    const reopened = open(name);
    const repository = new LocalFirstRepository(reopened, { send: async () => undefined });
    await repository.rehydrate();
    const state = repository.store.getState();
    repository.dispose();

    // #then
    expect(state.properties[property.id]).toMatchObject({ name: "성수동 새집", dirty: true });
    expect(state.rooms[room.id]?.layout.utilities[0]).toMatchObject({ id: "utility_0001", position: { x: 1_200, y: 1_000 } });
    expect(state.rooms[room.id]?.layout.notch).toBeUndefined();
  });

  it("still reads a layout that predates the fields the current schema knows about", () => {
    // #given
    const stored = {
      version: 1,
      position: { x: 900, y: 900 },
      size: { width: 4_400, height: 3_300 },
      doors: [{ id: "door_0001", wall: "north", offset: 400, width: 820, hinge: "left", opening: "inward" }],
      windows: [],
      utilities: [{ id: "utility_0001", type: "outlet", position: { x: 1_200, y: 1_000 } }],
    };

    // #when
    const layout = parseRoomLayout(stored);

    // #then
    expect(layout?.doors[0]).toMatchObject({ id: "door_0001", offset: 400 });
    expect(layout?.utilities[0]?.size).toBeUndefined();
    expect(parseRoomLayout({ version: 99, position: { x: 0, y: 0 } })).toBeNull();
  });

  it("uploads a record the server never received instead of retrying its update forever", async () => {
    // #given a device whose room was synced under an account that no longer exists
    const db = open(`durability-${crypto.randomUUID()}`);
    const property: LocalProperty = { id: "property_0003", name: "성수동 새집", address: null, note: null, createdAt: 3, updatedAt: 3, dirty: false };
    const room: LocalRoom = {
      id: "room_0003",
      propertyId: property.id,
      name: "거실",
      type: "living_room",
      layout: { version: 1, position: { x: 900, y: 900 }, size: { width: 4_400, height: 3_300 }, doors: [], windows: [], utilities: [] },
      createdAt: 3,
      updatedAt: 3,
      dirty: true,
    };
    await db.properties.put(property);
    await db.rooms.put(room);
    const sent: string[] = [];
    const known = new Set<string>();
    const repository = new LocalFirstRepository(db, {
      send: async (operation) => {
        sent.push(`${operation.method} ${operation.path}`);
        // Mirrors the Worker: a room can only be created under a property the account owns.
        if (operation.method === "POST") {
          if (operation.path.startsWith("/properties/") && !known.has(operation.propertyId)) throw new ApiRequestError(404);
          known.add(operation.entityId);
          return;
        }
        if (!known.has(operation.entityId)) throw new ApiRequestError(404);
      },
    });

    // #when the only queued work is an update for that unknown room
    await repository.persistOptimisticChange({
      entityKind: "room",
      entity: room,
      operation: { clientMutationId: "mutation_0003", method: "PUT", path: `/rooms/${room.id}/layout`, body: { clientMutationId: "mutation_0003", data: room.layout } },
    });
    await repository.flush();
    const state = repository.store.getState();
    repository.dispose();

    // #then the property and room are created, the update lands, and nothing is left behind
    expect(sent).toEqual([
      `PUT /rooms/${room.id}/layout`,
      `POST /properties/${property.id}/rooms`,
      "POST /properties",
      `POST /properties/${property.id}/rooms`,
    ]);
    expect(state.syncStatus).toBe("idle");
    expect(state.pendingOperationCount).toBe(0);
    expect(await db.operations.count()).toBe(0);
  });

  it("queues one upload for a plan nudged many times before it ever reaches the server", async () => {
    // #given
    const db = open(`durability-${crypto.randomUUID()}`);
    const room: LocalRoom = {
      id: "room_0004",
      propertyId: "property_0004",
      name: "거실",
      type: "living_room",
      layout: { version: 1, position: { x: 900, y: 900 }, size: { width: 4_400, height: 3_300 }, doors: [], windows: [], utilities: [] },
      createdAt: 4,
      updatedAt: 4,
      dirty: true,
    };
    const repository = new LocalFirstRepository(db, { send: async () => { throw new ApiRequestError(401); } });

    // #when the same room layout is written ten times while signed out
    for (let nudge = 0; nudge < 10; nudge += 1) {
      const layout = { ...room.layout, position: { x: 900 + nudge * 10, y: 900 } };
      await repository.persistOptimisticChange({
        entityKind: "room",
        entity: { ...room, layout },
        operation: { clientMutationId: `mutation_000400${nudge}`, method: "PUT", path: `/rooms/${room.id}/layout`, body: { clientMutationId: `mutation_000400${nudge}`, data: layout } },
      });
    }
    const queued = await db.operations.toArray();
    repository.dispose();

    // #then only the newest write is waiting, and it carries the latest position
    expect(queued).toHaveLength(1);
    expect((queued[0]?.body.data as { position: { x: number } }).position.x).toBe(990);
  });

  it("keeps queued mutations for a signed-out device instead of discarding them", async () => {
    // #given
    const name = `durability-${crypto.randomUUID()}`;
    const db = open(name);
    const repository = new LocalFirstRepository(db, {
      send: async () => { throw new ApiRequestError(401); },
    });
    const property: LocalProperty = { id: "property_0002", name: "미로그인 집", address: null, note: null, createdAt: 2, updatedAt: 2, dirty: false };

    // #when
    await repository.persistOptimisticChange({
      entityKind: "property",
      entity: property,
      operation: { clientMutationId: "mutation_0002", method: "POST", path: "/properties", body: { clientMutationId: "mutation_0002", data: { id: property.id, name: property.name } } },
    });
    await repository.flush();
    const state = repository.store.getState();
    repository.dispose();

    // #then
    expect(state.syncStatus).toBe("signed-out");
    expect(state.pendingOperationCount).toBe(1);
    expect(await db.operations.count()).toBe(1);
    expect(state.properties[property.id]?.name).toBe("미로그인 집");
  });
});
