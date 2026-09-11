import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import { HomeMeasureDatabase, LocalFirstRepository } from "../../local";
import type { ApiClient, LocalProperty, LocalRoom } from "../../local";
import { PhotoUploadQueue, type PhotoUploadClient } from "./photo-upload-queue";

class OnlineTarget {
  private listener: (() => void) | undefined;

  public addEventListener(type: string, listener: () => void): void {
    if (type === "online") this.listener = listener;
  }

  public removeEventListener(type: string, listener: () => void): void {
    if (type === "online" && this.listener === listener) this.listener = undefined;
  }

  public reconnect(): void {
    this.listener?.();
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("PhotoUploadQueue", () => {
  let db: HomeMeasureDatabase | undefined;
  let repository: LocalFirstRepository | undefined;
  let queue: PhotoUploadQueue | undefined;

  afterEach(async () => {
    queue?.dispose();
    repository?.dispose();
    await db?.delete();
  });

  it("preserves checklist context and the compressed Blob when the binary upload fails, then retries on reconnect", async () => {
    const operations: unknown[] = [];
    const api: ApiClient = { send: async (operation) => { operations.push(operation); } };
    db = new HomeMeasureDatabase(`photo-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, api, undefined);
    const online = new OnlineTarget();
    let attempts = 0;
    const uploadMutationIds: string[] = [];
    const uploader: PhotoUploadClient = {
      upload: async (_photo, cached) => {
        attempts += 1;
        uploadMutationIds.push(cached.uploadMutationId);
        if (attempts === 1) throw new TypeError("network unavailable");
      },
    };
    queue = new PhotoUploadQueue(repository, uploader, {
      dimensions: async () => ({ width: 3_840, height: 2_160 }),
      encode: async () => new Blob(["compressed image"], { type: "image/webp" }),
    }, online as unknown as Window);
    const property: LocalProperty = { id: "property_00001", name: "우리 집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const room: LocalRoom = {
      id: "room_00001", propertyId: property.id, name: "베란다", type: "balcony", createdAt: 1, updatedAt: 1, dirty: false,
      layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 2_000, height: 1_500 }, doors: [], windows: [], utilities: [] },
    };

    const photo = await queue.enqueue(new Blob(["camera source"], { type: "image/jpeg" }), {
      property,
      room,
      checklistItem: { id: "checklist_00001", label: "세탁기 공간 가로", elementId: "utility_00001" },
      note: "  배수구 쪽 여유 공간  ",
    });
    await queue.process();

    const cachedAfterFailure = await db.photoBlobs.get(photo.id);
    const failedPhoto = await db.photoMetadata.get(photo.id);
    expect(cachedAfterFailure?.blob.type).toBe("image/webp");
    expect(failedPhoto).toMatchObject({
      propertyId: property.id,
      roomId: room.id,
      elementId: "utility_00001",
      checklistItemId: "checklist_00001",
      note: "배수구 쪽 여유 공간",
      uploadStatus: "failed",
      uploadAttempts: 1,
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ body: { data: { note: "배수구 쪽 여유 공간" } } });
    expect(JSON.stringify(operations[0])).not.toContain("camera source");
    expect(JSON.stringify(operations[0])).not.toContain("compressed image");

    online.reconnect();
    await eventually(() => expect(repository?.store.getState().photoMetadata[photo.id]?.uploadStatus).toBe("uploaded"));
    expect(await db.photoBlobs.get(photo.id)).toBeUndefined();
    expect(uploadMutationIds).toHaveLength(2);
    expect(uploadMutationIds[0]).toBe(uploadMutationIds[1]);
  });

  it("rejects a photo note beyond the shared 4,000-character schema limit before caching a Blob", async () => {
    db = new HomeMeasureDatabase(`photo-note-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, { send: async () => undefined }, undefined);
    queue = new PhotoUploadQueue(repository, { upload: async () => undefined }, {
      dimensions: async () => ({ width: 100, height: 100 }),
      encode: async () => new Blob(["compressed image"], { type: "image/webp" }),
    }, new OnlineTarget() as unknown as Window);
    const property: LocalProperty = { id: "property_00003", name: "우리 집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const room: LocalRoom = {
      id: "room_00003", propertyId: property.id, name: "주방", type: "kitchen", createdAt: 1, updatedAt: 1, dirty: false,
      layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 2_000, height: 1_500 }, doors: [], windows: [], utilities: [] },
    };

    await expect(queue.enqueue(new Blob(["camera source"], { type: "image/jpeg" }), {
      property,
      room,
      checklistItem: { id: "checklist_00003", label: "주방 창문", elementId: null },
      note: "가".repeat(4_001),
    })).rejects.toThrow("사진 메모는 4,000자 이하로 입력하세요.");
    expect(await db.photoBlobs.count()).toBe(0);
    expect(await db.photoMetadata.count()).toBe(0);
  });
});
