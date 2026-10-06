/**
 * Shared message protocol between the whistle-vconsole probe (browser side)
 * and the MCP server (node side).
 *
 * Transport: JSON text frames over a single WebSocket connection.
 * The probe is the connecting side; the server listens.
 *
 * This file exists twice, on purpose: the node side keeps it at
 * vconsole-mcp/packages/protocol/src/protocol.ts, the probe side at
 * vConsole/src/mcp/protocol.ts. Nothing checks them against each other, so
 * changing the protocol means editing BOTH in the same round (ADR-0007).
 * PROTOCOL_VERSION is the only handshake between the two copies, and a hub
 * that sees a different number warns instead of disconnecting (ADR-0008).
 */

export const PROTOCOL_VERSION = 1;

/** Special-value markers emitted by the probe serializer. */
export type SerializedValue = string;

export interface LogItem {
  /** vConsole internal log id */
  id: string;
  type: 'log' | 'info' | 'debug' | 'warn' | 'error';
  /** set for command-line entries (human or agent typed) */
  cmdType?: 'input' | 'output';
  /** how many times this exact log repeated */
  repeated: number;
  /** epoch ms */
  date: number;
  /** serialized, display-ready arguments */
  args: SerializedValue[];
  groupLevel?: number;
}

export type NetworkRequestType =
  | 'xhr' | 'fetch' | 'ping' | 'custom'
  | 'img' | 'script' | 'stylesheet' | 'font' | 'resource' | 'websocket';

/**
 * A binary WebSocket frame cannot survive the JSON hop to the hub, so the probe
 * encodes it up front as `WS_BINARY_MARKER + base64[ + ':' + originalBytes ]`.
 * The tail is only present when the payload was capped to WS_BINARY_MAX_BYTES
 * (`:` is not part of the base64 alphabet, so the split is unambiguous).
 */
export const WS_BINARY_MARKER = '__vcb64__:';
export const WS_BINARY_MAX_BYTES = 8192;

export interface NetworkWsMessage {
  type: 'send' | 'receive';
  data: string;
  time: number;
}

export interface NetworkItem {
  id: string;
  requestType: NetworkRequestType;
  method: string;
  url: string;
  name?: string;
  status: number | string;
  statusText?: string;
  readyState?: number;
  /** 0=no cancel; 1=abort (XHR); 2=cancel (fetch); 3=timeout */
  cancelState?: number;
  requestHeader?: SerializedValue;
  responseHeader?: SerializedValue;
  postData?: SerializedValue;
  response?: SerializedValue;
  responseType?: string;
  responseSize?: number;
  getData?: SerializedValue;
  startTime?: number;
  endTime?: number;
  costTime?: number;
  transferSize?: number;
  /** websocket frames (websocket requestType only) */
  messages?: NetworkWsMessage[];
  /** id of the request this one was replayed from (see `replay_request`) */
  replayedFrom?: string;
}

export interface PageInfo {
  url: string;
  title: string;
  referrer: string;
  userAgent: string;
  platform: string;
  language: string;
  viewport: { width: number; height: number; dpr: number };
  screen: { width: number; height: number };
  visibility: 'visible' | 'hidden' | 'prerender';
  online: boolean;
  memory?: { usedJsHeapSize: number; totalJsHeapSize: number; jsHeapSizeLimit: number };
  navigation?: {
    type: string;
    ttfbMs?: number;
    domContentLoadedMs?: number;
    loadMs?: number;
    transferSize?: number;
  };
}

export interface StorageData {
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export type StorageKind = 'local' | 'session' | 'cookie';

export interface SetStorageResult {
  storage: StorageKind;
  key: string;
  /** the value the page actually holds after the write (a cookie write can be refused) */
  value: string;
}

export interface DomNodeInfo {
  tag: string;
  id?: string;
  classes?: string;
  outerHTML: string;
  childElementCount?: number;
}

export interface DomResult {
  selector: string;
  matched: number;
  returned: number;
  nodes: DomNodeInfo[];
}

export interface ScreenshotResult {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** base64-encoded image data (without data: prefix) */
  dataBase64: string;
}

export interface EvalResult {
  /** serialized result of the expression */
  result: SerializedValue;
  isException: boolean;
  durationMs: number;
}

export interface ReplayResult {
  /** status of THIS replay; the recorded request's own status is irrelevant here */
  status: number;
  statusText: string;
  responseHeader?: SerializedValue;
  /** response body, capped by the probe */
  body: string;
  truncated: boolean;
  /** full body length in bytes, before the cap */
  responseSize: number;
  costTime: number;
  /** id of the new network item this replay was recorded as */
  replayedId: string;
}

// ---------------------------------------------------------------------------
// Probe -> Server
// ---------------------------------------------------------------------------

/**
 * What the probe can say about the hardware that the UA cannot (UA reduction
 * freezes the Android model to "K"; an iPad asking for the desktop site reports
 * a plain Macintosh UA). Every field is optional — an old probe reports nothing.
 */
export interface RealDeviceHints {
  model?: string;
  osVersion?: string;
  /** navigator.maxTouchPoints > 0; the only way to spot an iPad in desktop-site mode */
  isTablet?: boolean;
}

export interface HelloMsg {
  type: 'hello';
  protocol: typeof PROTOCOL_VERSION;
  /** stable within one page lifecycle; reconnects reuse the same id */
  sessionId: string;
  deviceName?: string;
  realDevice?: RealDeviceHints;
  probeVersion: string;
  page: PageInfo;
}

export interface LogsMsg {
  type: 'logs';
  items: LogItem[];
  /** true when the in-page log store was cleared */
  reset?: boolean;
}

export interface NetworkMsg {
  type: 'network';
  items: NetworkItem[];
  /** true when the in-page network list was cleared */
  reset?: boolean;
}

export interface CmdResultMsg {
  type: 'result';
  reqId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface PongMsg {
  type: 'pong';
  t: number;
}

/**
 * Server<->server: an MCP process in proxy mode forwards a tool call to the
 * hub process that owns the WebSocket port. Reuses CmdResultMsg for replies.
 */
export type ToolApiName =
  | 'list_sessions' | 'select_session' | 'get_logs' | 'wait_for'
  | 'get_network' | 'ws_frames' | 'eval_js' | 'get_dom' | 'get_storage' | 'set_storage'
  | 'del_storage' | 'get_page_info' | 'screenshot' | 'replay_request';

export interface ApiMsg {
  type: 'api';
  reqId: string;
  api: ToolApiName;
  args: Record<string, unknown>;
  /** optional session targeting, honored by the hub-side tool runtime */
  opts?: { sessionId?: string };
}

/** hello.sessionId used by proxy-mode MCP processes (never shown as a session) */
export const MCP_PROXY_SESSION_ID = '__mcp_proxy__';

export type ProbeMessage =
  | HelloMsg
  | LogsMsg
  | NetworkMsg
  | CmdResultMsg
  | PongMsg
  | ApiMsg;

// ---------------------------------------------------------------------------
// Server -> Probe
// ---------------------------------------------------------------------------

export type CmdType = 'eval' | 'get_dom' | 'get_storage' | 'set_storage' | 'del_storage' | 'page_info' | 'screenshot' | 'replay';

export interface CmdMsg {
  type: 'cmd';
  reqId: string;
  cmd: CmdType;
  args?: Record<string, unknown>;
}

export interface PingMsg {
  type: 'ping';
  t: number;
}

/**
 * Server -> Probe: another page on the SAME device (same fingerprint ->
 * same sessionId) just connected; the superseded probe must back off and
 * stop reconnecting until its page becomes visible again.
 */
export interface KickMsg {
  type: 'kick';
}

export type ServerMessage = CmdMsg | PingMsg | KickMsg;

// ---------------------------------------------------------------------------
// Option types (probe init)
// ---------------------------------------------------------------------------

export interface VConsoleMcpOptions {
  /** WebSocket endpoint of the MCP server, e.g. ws://192.168.1.10:9528 */
  serverUrl: string;
  /** optional human-readable label, e.g. "iPhone 15 测试机" */
  deviceName?: string;
  /** set false to keep collecting data but never connect (default: true) */
  autoConnect?: boolean;
  /** hide the vConsole switch button + panel for agent-only usage (default: false) */
  hideUI?: boolean;
  /** max buffered log/network items kept for (re)delivery, per stream (default: 2000) */
  maxBuffer?: number;
}
