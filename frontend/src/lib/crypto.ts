// @ts-nocheck
// Stub for Web Crypto API used in CloudVault
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptFile(file: File, key: CryptoKey): Promise<{ encrypted: Blob; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buffer = await file.arrayBuffer();
  const encryptedBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { encrypted: new Blob([encryptedBuf]), iv };
}

export async function decryptFile(encrypted: Blob, key: CryptoKey, iv: Uint8Array): Promise<Blob> {
  const buffer = await encrypted.arrayBuffer();
  const decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buffer);
  return new Blob([decryptedBuf]);
}
