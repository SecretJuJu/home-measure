import { describe, expect, it } from "vitest";

import { compressPhoto, MAX_PHOTO_EDGE, scaledPhotoDimensions, validatePhotoFile } from "./photo-processing";

describe("photo compression", () => {
  it("downscales the longest edge to 1920 and retains a WebP result when supported", async () => {
    const source = new Blob(["source"], { type: "image/jpeg" });
    const compressed = await compressPhoto(source, {
      dimensions: async () => ({ width: 4_000, height: 2_000 }),
      encode: async (_file, width, height) => {
        expect({ width, height }).toEqual({ width: MAX_PHOTO_EDGE, height: 960 });
        return new Blob(["compressed"], { type: "image/webp" });
      },
    });

    expect(compressed).toMatchObject({ width: 1_920, height: 960, mimeType: "image/webp" });
  });

  it("keeps smaller images at their original dimensions and accepts JPEG fallback output", async () => {
    const source = new Blob(["source"], { type: "image/png" });
    const compressed = await compressPhoto(source, {
      dimensions: async () => ({ width: 800, height: 600 }),
      encode: async () => new Blob(["jpeg fallback"], { type: "image/jpeg" }),
    });

    expect(compressed).toMatchObject({ width: 800, height: 600, mimeType: "image/jpeg" });
    expect(scaledPhotoDimensions(1_920, 800)).toEqual({ width: 1_920, height: 800 });
  });

  it("rejects unsupported source MIME types before decoding", () => {
    expect(() => validatePhotoFile(new Blob(["not an image"], { type: "image/gif" }))).toThrow("JPEG, PNG 또는 WebP");
  });
});
