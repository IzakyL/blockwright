import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export const linuxDriverEntry = 'package/dist/native/linux-x64/blockwright';

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Unsupported tar numeric field');
  return value ? parseInt(value, 8) : 0;
}

function entries(bytes) {
  const result = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return result;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = octal(header.subarray(124, 136));
    if (offset + 512 + size > bytes.length) throw new Error('Truncated npm archive');
    result.push({ name: prefix ? `${prefix}/${name}` : name, offset, mode: octal(header.subarray(100, 108)), type: header[156] });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Unterminated npm archive');
}

/** NTFS cannot retain Linux executable bits; set only this known tar entry, then recompute its checksum. */
export function normalizeLinuxDriverMode(path) {
  const bytes = gunzipSync(readFileSync(path));
  const found = entries(bytes).filter(entry => entry.name === linuxDriverEntry);
  if (found.length !== 1 || ![0, 48].includes(found[0].type)) throw new Error('The client archive must contain exactly one regular Linux driver');
  if (found[0].mode === 0o755) return;
  const header = bytes.subarray(found[0].offset, found[0].offset + 512);
  header.write('0000755\0', 100, 8, 'ascii');
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  writeFileSync(path, gzipSync(bytes, { level: 9 }));
}

export function verifyLinuxDriverMode(path) {
  const found = entries(gunzipSync(readFileSync(path))).filter(entry => entry.name === linuxDriverEntry);
  if (found.length !== 1 || found[0].mode !== 0o755) throw new Error('Linux driver tar mode must be 0755');
}
