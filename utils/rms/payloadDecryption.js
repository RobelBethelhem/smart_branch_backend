import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const key = process.env.REQUEST_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(`REQUEST_ENCRYPTION_KEY must be a 64-char hex string (got: ${key ? `length=${key.length}` : 'undefined'})`);
  }
  return Buffer.from(key, 'hex');
}

/**
 * Decrypt an encrypted request payload.
 * @param {string} encryptedPayload - Format: "iv:authTag:ciphertext" (hex-encoded)
 * @returns {object} Parsed JSON object
 */
export function decryptPayload(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('Encrypted payload is required');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid encrypted payload format: expected 3 parts, got ${parts.length}`);
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;


  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');


  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  // Use Buffer.concat to avoid encoding issues with Buffer + string concatenation
  const decryptedBuffer = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  const decryptedStr = decryptedBuffer.toString('utf8');

  return JSON.parse(decryptedStr);
}
