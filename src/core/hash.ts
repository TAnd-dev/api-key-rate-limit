/**
 * Key hashing with Web Crypto, so it works in Node 20+, Bun, Deno and Workers
 * without `node:crypto`.
 *
 * Raw API keys must not end up in Redis (a dump or `MONITOR` would leak them)
 * or in logs. API keys are high-entropy, so plain SHA-256 is already not
 * reversible; with a secret, HMAC-SHA-256 also protects low-entropy keys
 * against offline guessing.
 */
export type KeyHasher = (key: string) => Promise<string>;

export type HashKeysOption = boolean | { secret: string | Uint8Array } | ((key: string) => string | Promise<string>);

const encoder = new TextEncoder();

export function createKeyHasher(option: HashKeysOption = true): KeyHasher {
  if (option === false) return (key) => Promise.resolve(key);
  if (typeof option === 'function') return async (key) => option(key);

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto (globalThis.crypto.subtle) is required to hash keys; use Node 20+ or pass hashKeys: false');
  }

  if (option === true) {
    return async (key) => toBase64Url(await subtle.digest('SHA-256', encoder.encode(key)));
  }

  const secret = typeof option.secret === 'string' ? encoder.encode(option.secret) : option.secret;
  if (secret.byteLength === 0) throw new RangeError('hashKeys.secret must not be empty');
  // Imported once, lazily: importKey is async and the constructor is not.
  let cryptoKey: ReturnType<typeof subtle.importKey> | undefined;
  return async (key) => {
    cryptoKey ??= subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toBase64Url(await subtle.sign('HMAC', await cryptoKey, encoder.encode(key)));
  };
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
