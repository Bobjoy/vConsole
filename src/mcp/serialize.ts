/**
 * Display-oriented value serializer for the MCP bridge.
 *
 * Everything crossing the wire is a display-ready string, similar to what
 * a human sees in the vConsole panel. Guards: circular refs, max depth,
 * max entries per object/array, max chars per string, total budget.
 */

const MAX_DEPTH = 4;
const MAX_ARRAY_ENTRIES = 50;
const MAX_OBJECT_ENTRIES = 100;
const MAX_STR_CHARS = 2000;
const MAX_TOTAL_CHARS = 240 * 1024;

export const TRUNCATE_MARK = '…[truncated]';

let totalBudget = MAX_TOTAL_CHARS;

export function resetBudget() {
  totalBudget = MAX_TOTAL_CHARS;
}

function takeBudget(n: number) {
  totalBudget -= n;
}

function budgetLeft(): boolean {
  return totalBudget > 0;
}

function truncateString(s: string, max = MAX_STR_CHARS): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max) + TRUNCATE_MARK + `(+${s.length - max} chars)`;
}

function describeTag(v: any): string {
  if (v instanceof Element) {
    const tag = (v.tagName || '').toLowerCase();
    const id = v.id ? `#${v.id}` : '';
    const cls = v.classList && v.classList.length ? `.${Array.from(v.classList).slice(0, 3).join('.')}` : '';
    return `<${tag}${id}${cls}>`;
  }
  return '';
}

export function serializeValue(v: any, depth = 0): string {
  if (!budgetLeft()) {
    return '…[budget exceeded]';
  }

  try {
    if (v === null) { return 'null'; }
    if (v === undefined) { return 'undefined'; }

    const t = typeof v;
    if (t === 'string') { return truncateString(v); }
    if (t === 'number') { return Number.isNaN(v) ? 'NaN' : String(v); }
    if (t === 'boolean') { return String(v); }
    if (t === 'bigint') { return `${v}n`; }
    if (t === 'symbol') { return v.toString(); }
    if (t === 'function') {
      const name = v.name ? `: ${v.name}` : '';
      return `[Function${name}]`;
    }
    if (t === 'object') {
      if (v instanceof Error) {
        const stack = typeof v.stack === 'string' ? '\n' + truncateString(v.stack, 1000) : '';
        return truncateString(`${v.name || 'Error'}: ${v.message}${stack}`);
      }
      if (v instanceof Date) { return v.toISOString(); }
      if (v instanceof RegExp) { return v.toString(); }
      if (typeof Element !== 'undefined' && v instanceof Element) { return describeTag(v); }

      if (depth >= MAX_DEPTH) {
        return Array.isArray(v) ? '[Array]' : `{${(v.constructor && v.constructor.name) || 'Object'}}`;
      }

      // plain-ish object or array
      if (Array.isArray(v)) {
        const parts: string[] = [];
        const len = v.length;
        const shown = Math.min(len, MAX_ARRAY_ENTRIES);
        for (let i = 0; i < shown; i++) {
          parts.push(serializeValue(v[i], depth + 1));
        }
        let s = `[${parts.join(', ')}`
        if (len > shown) { s += `, …(+${len - shown} items)`; }
        s += ']';
        takeBudget(s.length);
        return truncateString(s);
      }

      // Map / Set
      if (typeof Map !== 'undefined' && v instanceof Map) {
        const parts: string[] = [];
        let i = 0;
        for (const [k, val] of v) {
          if (i++ >= MAX_OBJECT_ENTRIES) { break; }
          parts.push(`${serializeValue(k, depth + 1)} => ${serializeValue(val, depth + 1)}`);
        }
        let s = `Map(${v.size}) {${parts.join(', ')}}`;
        if (v.size > MAX_OBJECT_ENTRIES) { s += TRUNCATE_MARK; }
        takeBudget(s.length);
        return truncateString(s);
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        const parts: string[] = [];
        let i = 0;
        for (const val of v) {
          if (i++ >= MAX_OBJECT_ENTRIES) { break; }
          parts.push(serializeValue(val, depth + 1));
        }
        let s = `Set(${v.size}) {${parts.join(', ')}}`;
        if (v.size > MAX_OBJECT_ENTRIES) { s += TRUNCATE_MARK; }
        takeBudget(s.length);
        return truncateString(s);
      }

      // typed arrays & ArrayBuffer
      if (ArrayBuffer.isView(v)) {
        // DataView has no `length`, only `byteLength`
        const len = (v as { length?: number }).length;
        return `${(v.constructor && v.constructor.name) || 'TypedArray'}(${len === undefined ? v.byteLength : len})`;
      }
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) {
        return `ArrayBuffer(${v.byteLength})`;
      }

      // generic object
      const name = (v.constructor && v.constructor.name) || 'Object';
      const keys = Object.keys(v);
      const shown = Math.min(keys.length, MAX_OBJECT_ENTRIES);
      const parts: string[] = [];
      let sawCircular = false;
      for (let i = 0; i < shown; i++) {
        const key = keys[i];
        let valStr: string;
        try {
          if (v[key] === v) {
            valStr = '[Circular]';
            sawCircular = true;
          } else {
            valStr = serializeValue(v[key], depth + 1);
          }
        } catch (e) {
          valStr = '[getter error]';
        }
        parts.push(`${key}: ${valStr}`);
      }
      let s = `{${parts.join(', ')}`
      if (keys.length > shown) { s += `, …(+${keys.length - shown} keys)`; }
      s += '}';
      if (!sawCircular && name !== 'Object' && depth === 0) { s = `${name} ${s}`; }
      takeBudget(s.length);
      return truncateString(s);
    }

    return String(v);
  } catch (e) {
    return '[unserializable]';
  }
}

/** Serialize a list of console args into display strings. */
export function serializeArgs(args: any[]): string[] {
  resetBudget();
  return (args || []).map((a) => serializeValue(a));
}

/** Serialize one value with a fresh budget. */
export function serializeOne(v: any): string {
  return serializeValue(v);
}
