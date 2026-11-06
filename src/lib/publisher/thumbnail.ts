import { frameAt } from "./frame";

/** The longest side of a kept thumbnail: sharp in a list and a post's header on a dense screen, and a few dozen KB. */
const EDGE = 480;
function drawSmall(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context || !width || !height) return Promise.reject(new Error("Nothing to draw"));
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode"))), "image/jpeg", 0.8),
  );
}
/** A thumbnail of a photo, or of a video's opening frame. Rejects when this browser can't decode it. */
export async function thumbnailOf(file: File): Promise<Blob> {
  const picture = file.type.startsWith("video/") ? await frameAt(file, 0.1) : file;
  const bitmap = await createImageBitmap(picture);
  try {
    return await drawSmall(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
/** A thumbnail of what an image or video element on the page is showing. */
export function thumbnailFrom(element: HTMLImageElement | HTMLVideoElement): Promise<Blob> {
  return element instanceof HTMLVideoElement
    ? drawSmall(element, element.videoWidth, element.videoHeight)
    : drawSmall(element, element.naturalWidth, element.naturalHeight);
}
/** Keeps the thumbnail with its post. Best effort: without one, the post falls back to its other pictures. */
export async function saveThumbnail(job: string, thumbnail: Blob) {
  const response = await fetch(`/api/publisher/jobs/${job}/thumbnail`, {
    method: "PUT",
    headers: { "Content-Type": thumbnail.type },
    body: thumbnail,
  });
  if (!response.ok) throw new Error("The thumbnail wasn't kept");
}
