// Only ciphertext crosses the publisher API. The private key stays on the laptop.
export interface EncryptedCredentials {
  key: string;
  iv: string;
  data: string;
}
const encode = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export async function encryptCredentials(
  publicKey: JsonWebKey,
  credentials: { service: string; identifier: string; password: string },
): Promise<EncryptedCredentials> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const recipient = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {
    key: encode(
      await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipient, await crypto.subtle.exportKey("raw", key)),
    ),
    iv: encode(iv.buffer),
    data: encode(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(credentials)),
      ),
    ),
  };
}
export function validEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  const v = value as EncryptedCredentials;
  return (
    !!v &&
    typeof v.key === "string" &&
    /^[A-Za-z0-9+/]{342}==$/.test(v.key) &&
    typeof v.iv === "string" &&
    /^[A-Za-z0-9+/]{16}$/.test(v.iv) &&
    typeof v.data === "string" &&
    v.data.length >= 24 &&
    v.data.length <= 12000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(v.data)
  );
}
