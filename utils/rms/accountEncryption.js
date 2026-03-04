import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getKey() {
  const key = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ACCOUNT_ENCRYPTION_KEY must be set as a 64-char hex string in .env');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt an account number into an opaque token.
 * Token format: iv:authTag:ciphertext (hex-encoded)
 * Embedded TTL: plaintext = "accountNumber|timestamp"
 */
export function encryptAccountNumber(accountNumber) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const plaintext = `${accountNumber}|${Date.now()}`;
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an encrypted token back to the original account number.
 * Validates token format, integrity, and TTL.
 */
export function decryptAccountToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token is required');
  }

  const parts = token.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  const decrypted = decipher.update(ciphertext) + decipher.final('utf8');

  const [accountNumber, timestampStr] = decrypted.split('|');
  const timestamp = parseInt(timestampStr, 10);

  if (Date.now() - timestamp > TOKEN_TTL_MS) {
    throw new Error('Token expired');
  }

  if (!/^\d{16}$/.test(accountNumber)) {
    throw new Error('Invalid decrypted account number');
  }

  return accountNumber;
}

/**
 * Extract CIF from a 16-digit account number.
 * CIF = 7 digits: remove last 3, take last 7
 */
export function extractCIF(accountNumber) {
  const withoutLast3 = accountNumber.slice(0, -3);
  return withoutLast3.slice(-7);
}
