import type { ArchiveBucket } from "./archive";
import type { MediaBucket } from "./server";

/** Buckets kept in memory for tests, as R2 behaves where the publisher relies on it. */
type Stored = { bytes: Uint8Array; contentType?: string; uploaded: Date };

const toBytes = (body: ArrayBuffer | ArrayBufferView | string) =>
  typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);

/** A body R2 takes, stream or bytes, read whole. */
const bytesOf = async (body: ReadableStream | ArrayBuffer | ArrayBufferView | string) =>
  body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : toBytes(body);

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, "0")).join("");

function read(objects: Map<string, Stored>, key: string) {
  const object = objects.get(key);
  return object
    ? {
        body: new Response(object.bytes.slice()).body as ReadableStream,
        httpMetadata: { contentType: object.contentType },
        size: object.bytes.byteLength,
        uploaded: object.uploaded,
      }
    : null;
}

function list(objects: Map<string, Stored>, prefix: string) {
  return {
    objects: [...objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded })),
    truncated: false,
  };
}

export function memoryMedia() {
  const objects = new Map<string, Stored>();
  const bucket: MediaBucket = {
    async put(key, body, options) {
      objects.set(key, { bytes: toBytes(body), contentType: options?.httpMetadata.contentType, uploaded: new Date() });
    },
    async get(key) {
      return read(objects, key);
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix }) {
      return list(objects, prefix);
    },
  };
  return { bucket, objects };
}

export function memoryArchive() {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const bucket: ArchiveBucket = {
    async put(key, body, options) {
      const bytes = await bytesOf(body);
      // R2 refuses a body that doesn't match the hash it's given.
      if (options?.sha256 && hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))) !== options.sha256)
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType, uploaded: new Date() });
    },
    async get(key) {
      return read(objects, key);
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength } : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix }) {
      return list(objects, prefix);
    },
    async createMultipartUpload(key) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = () => {
        const found = uploads.get(uploadId);
        if (!found || found.key !== key) throw new Error("The specified multipart upload does not exist.");
        return found;
      };
      return {
        async uploadPart(partNumber, body) {
          upload().parts.set(partNumber, await bytesOf(body));
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          const sent = upload();
          const chunks = [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => sent.parts.get(p.partNumber));
          if (chunks.some((chunk) => !chunk)) throw new Error("A part is missing");
          const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + (chunk as Uint8Array).byteLength, 0));
          let at = 0;
          for (const chunk of chunks as Uint8Array[]) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
          }
          objects.set(key, { bytes, uploaded: new Date() });
          uploads.delete(uploadId);
        },
        async abort() {
          uploads.delete(uploadId);
        },
      };
    },
  };
  return { bucket, objects, uploads };
}
