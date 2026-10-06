/**
 * WebSocket payload encoding for the JSON hop to the hub.
 *
 * Binary frames (ArrayBuffer, typed arrays, Blob) are turned into a marked base64
 * string (WS_BINARY_MARKER in the shared protocol) because JSON.stringify degrades
 * them to `{}`. A Blob can only be read asynchronously, so encodeWsData hands back
 * a readable placeholder plus a `fill` callback; the caller replaces the message
 * data when the bytes arrive and the hub refreshes the frame it already recorded.
 */

import { WS_BINARY_MARKER, WS_BINARY_MAX_BYTES } from '@bobjoy/vconsole-protocol';

export interface EncodedWsData {
  value: string;
  /** set for Blobs only: call it with the encoded value once the bytes are readable */
  fill?: (apply: (value: string) => void) => void;
}

const toBytes = (data: any): Uint8Array | null => {
  if (typeof ArrayBuffer === 'undefined') { return null; }
  if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
};

/** `total` is the original byte count when `head` was capped, so truncation stays visible. */
const markBytes = (head: Uint8Array, total?: number): string => {
  const size = total || head.length;
  const capped = head.length < size;
  return WS_BINARY_MARKER + bytesToBase64(head) + (capped ? ':' + size : '');
};

const capBytes = (bytes: Uint8Array): Uint8Array => (
  bytes.length > WS_BINARY_MAX_BYTES ? bytes.subarray(0, WS_BINARY_MAX_BYTES) : bytes
);

const readBlobBytes = (blob: Blob): Promise<Uint8Array> => {
  const sliced = blob.size > WS_BINARY_MAX_BYTES ? blob.slice(0, WS_BINARY_MAX_BYTES) : blob;
  if (typeof sliced.arrayBuffer === 'function') {
    return sliced.arrayBuffer().then((buf: ArrayBuffer) => new Uint8Array(buf));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(sliced);
  });
};

export function encodeWsData(data: any): EncodedWsData {
  if (typeof data === 'string') { return { value: data }; }
  if (data === null || data === undefined) { return { value: String(data) }; }
  const bytes = toBytes(data);
  if (bytes) { return { value: markBytes(capBytes(bytes), bytes.length) }; }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    const blob = data as Blob;
    return {
      value: 'Blob(' + blob.size + ')',
      fill: (apply: (value: string) => void) => {
        readBlobBytes(blob).then(
          (head) => apply(markBytes(head, blob.size)),
          () => { /* unreadable Blob keeps the placeholder */ },
        );
      },
    };
  }
  return { value: String(data) };
}
