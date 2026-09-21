const crypto = require('crypto');
require('dotenv').config();

// Ensure 32-byte key for aes-256-gcm
const rawKey = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(rawKey).digest();
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts plaintext string into ciphertext, iv, and auth_tag
 * @param {string} text
 * @returns {{ encrypted: string, iv: string, authTag: string }}
 */
function encrypt(text) {
    if (!text) return { encrypted: '', iv: '', authTag: '' };
    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
        encrypted,
        iv: iv.toString('hex'),
        authTag
    };
}

/**
 * Decrypts ciphertext using iv and auth_tag
 * @param {string} encryptedHex
 * @param {string} ivHex
 * @param {string} authTagHex
 * @returns {string} plaintext
 */
function decrypt(encryptedHex, ivHex, authTagHex) {
    if (!encryptedHex) return '';
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

module.exports = {
    encrypt,
    decrypt
};
