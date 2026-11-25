/**
 * Client-side AES-256-GCM encryption for private agent notes.
 * The server stores only { ciphertext, iv } and never sees the workspace key or plaintext.
 */

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveWorkspaceKey(workspace: string, passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`switchboard:${workspace}`),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptNote(
  workspace: string,
  passphrase: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveWorkspaceKey(workspace, passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    ciphertext: toBase64(new Uint8Array(cipherBuf)),
    iv: toBase64(iv),
  };
}

export async function decryptNote(
  workspace: string,
  passphrase: string,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await deriveWorkspaceKey(workspace, passphrase);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plainBuf);
}
