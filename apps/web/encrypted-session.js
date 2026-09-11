const DB_NAME = 'qiyu-device-keys-v1';
const STORE = 'keys';
const KEY_ID = 'closed-trial-session-aes-gcm';

// 两级存储合同：
// - v1（安全上下文：HTTPS 或 localhost）：AES-GCM + IndexedDB 设备密钥，现状不变。
// - v2（非安全上下文降级，如封测期 http://IP 直连）：base64 编码 + 明确 encoding 标记。
//   不伪装成加密；会话令牌的暴露面与本页任何脚本一致（同源可读），封测白名单
//   边界下可接受。HTTPS 启用后新会话自动回到 v1。
export async function loadEncryptedSession(storageKey) {
  const envelope = sessionStorage.getItem(storageKey);
  if (!envelope) return null;
  try {
    const parsed = JSON.parse(envelope);
    if (parsed.v === 2 && parsed.encoding === 'base64' && typeof parsed.data === 'string') {
      return JSON.parse(new TextDecoder().decode(decode(parsed.data)));
    }
    if (parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.data !== 'string') return null;
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(parsed.iv) }, key, decode(parsed.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    sessionStorage.removeItem(storageKey);
    return null;
  }
}

export async function saveEncryptedSession(storageKey, value) {
  if (!secureStorageAvailable()) {
    sessionStorage.setItem(storageKey, JSON.stringify({ v: 2, encoding: 'base64', data: encode(new TextEncoder().encode(JSON.stringify(value))) }));
    return;
  }
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  sessionStorage.setItem(storageKey, JSON.stringify({ v: 1, iv: encode(iv), data: encode(new Uint8Array(data)) }));
}

export function clearEncryptedSession(storageKey) { sessionStorage.removeItem(storageKey); }

function secureStorageAvailable() { return Boolean(globalThis.crypto?.subtle && globalThis.indexedDB); }

async function deviceKey() {
  if (!secureStorageAvailable()) throw new Error('Secure browser storage unavailable');
  const db = await openDb();
  const existing = await transaction(db, 'readonly', (store) => store.get(KEY_ID));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await transaction(db, 'readwrite', (store) => store.put(key, KEY_ID));
  return key;
}
function openDb() { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => request.result.createObjectStore(STORE); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function transaction(db, mode, action) { return new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); tx.onabort = () => reject(tx.error); }); }
function encode(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function decode(value) { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
