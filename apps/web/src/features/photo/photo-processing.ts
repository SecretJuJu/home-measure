export const ACCEPTED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedPhotoMimeType = (typeof ACCEPTED_PHOTO_MIME_TYPES)[number];

/** Keep the post-compression payload under the Worker's binary request limit. */
export const MAX_SOURCE_PHOTO_BYTES = 24 * 1024 * 1024;
export const MAX_UPLOAD_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_EDGE = 1_920;

export interface CompressedPhoto {
  blob: Blob;
  width: number;
  height: number;
  mimeType: AcceptedPhotoMimeType;
}

export interface PhotoCompressionAdapter {
  dimensions(file: Blob): Promise<{ width: number; height: number }>;
  encode(file: Blob, width: number, height: number): Promise<Blob>;
}

function isAcceptedMimeType(value: string): value is AcceptedPhotoMimeType {
  return (ACCEPTED_PHOTO_MIME_TYPES as readonly string[]).includes(value);
}

export function validatePhotoFile(file: Blob): asserts file is Blob & { type: AcceptedPhotoMimeType } {
  if (!isAcceptedMimeType(file.type)) throw new Error("JPEG, PNG 또는 WebP 이미지만 첨부할 수 있습니다.");
  if (file.size <= 0 || file.size > MAX_SOURCE_PHOTO_BYTES) {
    throw new Error("24MB 이하의 사진만 첨부할 수 있습니다.");
  }
}

export function scaledPhotoDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("이미지 크기를 읽을 수 없습니다.");
  }
  const longestEdge = Math.max(width, height);
  if (longestEdge <= MAX_PHOTO_EDGE) return { width: Math.round(width), height: Math.round(height) };
  const scale = MAX_PHOTO_EDGE / longestEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasBlob(canvas: HTMLCanvasElement, type: AcceptedPhotoMimeType): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.82));
}

async function decodedImage(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("이미지를 열 수 없습니다."));
      element.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Browser implementation: try WebP first, then intentionally fall back to JPEG. */
export const browserPhotoCompressionAdapter: PhotoCompressionAdapter = {
  async dimensions(file) {
    const decoded = await decodedImage(file);
    try {
      return { width: decoded.width, height: decoded.height };
    } finally {
      decoded.release();
    }
  },
  async encode(file, width, height) {
    const decoded = await decodedImage(file);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("사진 압축을 시작할 수 없습니다.");
      context.drawImage(decoded.image, 0, 0, width, height);
      const webp = await canvasBlob(canvas, "image/webp");
      if (webp?.type === "image/webp") return webp;
      const jpeg = await canvasBlob(canvas, "image/jpeg");
      if (!jpeg || jpeg.type !== "image/jpeg") throw new Error("사진을 JPEG로 압축할 수 없습니다.");
      return jpeg;
    } finally {
      decoded.release();
    }
  },
};

export async function compressPhoto(
  file: Blob,
  adapter: PhotoCompressionAdapter = browserPhotoCompressionAdapter,
): Promise<CompressedPhoto> {
  validatePhotoFile(file);
  const original = await adapter.dimensions(file);
  const dimensions = scaledPhotoDimensions(original.width, original.height);
  const blob = await adapter.encode(file, dimensions.width, dimensions.height);
  if (!isAcceptedMimeType(blob.type) || blob.size <= 0 || blob.size > MAX_UPLOAD_PHOTO_BYTES) {
    throw new Error("압축된 사진을 업로드할 수 없습니다.");
  }
  return { blob, ...dimensions, mimeType: blob.type };
}

export function photoFileExtension(mimeType: AcceptedPhotoMimeType): "jpg" | "png" | "webp" {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
  }
}

/** This constrained key is checked again by the Worker before it reaches R2. */
export function photoObjectKey(propertyId: string, photoId: string, mimeType: AcceptedPhotoMimeType): string {
  return `photos/${propertyId}/${photoId}.${photoFileExtension(mimeType)}`;
}
