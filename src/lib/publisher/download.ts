/**
 * Reads a response body into a Blob, reporting the bytes as they arrive. `total` is the response's Content-Length,
 * absent when the server didn't send one.
 */
export async function readWithProgress(
  response: Response,
  onProgress: (loaded: number, total?: number) => void,
): Promise<Blob> {
  const length = Number(response.headers.get("Content-Length"));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const type = response.headers.get("Content-Type") ?? "";
  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, total ?? blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A fetch body's chunks are plain ArrayBuffer views, which is what Blob takes.
    chunks.push(value as Uint8Array<ArrayBuffer>);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  return new Blob(chunks, { type });
}

/** "45 of 81 MB", or "45 MB" without a total; a tenth of a megabyte below ten. */
export function describeProgress(loaded: number, total?: number): string {
  const mb = (bytes: number) => (bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0);
  return total ? `${mb(loaded)} of ${mb(total)} MB` : `${mb(loaded)} MB`;
}
