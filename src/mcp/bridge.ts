/**
 * MCP bridge for the vConsole fork.
 *
 * Taps vConsole's data layer (log stores + network model) and streams it to
 * the MCP server over WebSocket; executes commands coming back (eval, dom,
 * storage, page info, screenshot, replay).
 *
 * Delivery model:
 * - every tapped item is appended to a bounded ring buffer (serialized once)
 * - flush() sends buffer items after the flush cursor (incremental)
 * - on every (re)connect the cursor resets to 0 and the whole buffer is
 *   re-sent; the server dedupes by item id (last write wins)
 */

import type { VConsole } from '../core/core';
import { VConsoleLogModel } from '../log/log.model';
import { VConsoleLogStore as LogStore } from '../log/log.store';
import { VConsoleNetworkModel } from '../network/network.model';
import type { VConsoleNetworkRequestItem } from '../network/requestItem';
import type { IVConsoleLog } from '../log/log.model';

import type {
  VConsoleMcpOptions, LogItem, NetworkItem, ServerMessage, ProbeMessage, StorageKind, RealDeviceHints,
} from '@bobjoy/vconsole-protocol';
import { PROTOCOL_VERSION } from '@bobjoy/vconsole-protocol';
import { WSClient } from './wsClient';
import { serializeArgs, serializeOne } from './serialize';
import {
  evalExpression, getDom, getStorage, setStorage, delStorage, getPageInfo, screenshot, replay,
} from './commands';

const FLUSH_INTERVAL_MS = 150;
const MAX_ITEMS_PER_MSG = 200;
const MAX_MSG_BYTES = 256 * 1024;
const SENT_REPEAT_MAP_CAP = 4000;

/** 32-bit FNV-1a -> 8 hex chars; enough to tell mobile devices apart. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply-free mixing: h = (h ^ c) * 16777619
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ('00000000' + hash.toString(16)).slice(-8);
}

/**
 * The hub answers plain GETs on its own port, so the vendored html2canvas is
 * always one `ws -> http` swap away from the endpoint the page already reaches
 * (origin only: a path-prefixed `wss://host/ws` must not swallow the asset path).
 */
function localAssetUrl(serverUrl: string): string {
  try {
    return `${new URL(serverUrl.replace(/^ws/, 'http')).origin}/html2canvas.min.js`;
  } catch {
    return '';
  }
}

export function initMcpBridge(vConsole: VConsole, opts: VConsoleMcpOptions): VConsoleMcpBridge {
  const existing = (<any>vConsole).__mcpBridge;
  if (existing) {
    return existing;
  }
  const bridge = new VConsoleMcpBridge(vConsole, opts);
  (<any>vConsole).__mcpBridge = bridge;
  return bridge;
}

export class VConsoleMcpBridge {
  private vConsole: VConsole;
  private opts: VConsoleMcpOptions;
  private ws: WSClient;
  private sessionId: string;
  /** real model/os from client hints (UA reduction freezes the model to "K") */
  private realDevice: RealDeviceHints | undefined;
  private realDeviceReady: Promise<void> = Promise.resolve();

  /** serialized items waiting for delivery (bounded ring) */
  private logBuffer: LogItem[] = [];
  private networkBuffer: NetworkItem[] = [];
  /** index of the first not-yet-flushed item */
  private logCursor = 0;
  private networkCursor = 0;
  /** set when the in-page store was cleared; delivered as a reset marker */
  private resetPending = { logs: false, network: false };

  /** last-sent repeated count per log id, to re-send on repeat bumps */
  private sentLogRepeated: Map<string, number> = new Map();

  private flushTimer: any = null;
  private maxBuffer: number;
  private kickResumeHandler: (() => void) | null = null;
  /** vendored html2canvas, fetched from the hub origin before any CDN */
  private assetUrl: string;

  constructor(vConsole: VConsole, opts: VConsoleMcpOptions) {
    this.vConsole = vConsole;
    this.opts = opts;
    this.maxBuffer = opts.maxBuffer || 2000;
    this.sessionId = this.genSessionId();
    this.assetUrl = localAssetUrl(opts.serverUrl);

    this.ws = new WSClient({
      url: opts.serverUrl,
      sessionId: this.sessionId,
      maxQueue: 100,
      onOpen: () => this.onOpen(),
      onMessage: (data) => this.onServerMessage(data),
    });

    this.tapLogs();
    this.tapNetwork();

    this.startConsoleGuard();

    // Chromium's UA reduction freezes the UA model field to "K" (and the
    // Android version to 10) — resolve the real model via high-entropy client
    // hints BEFORE the first hello, capped so a broken environment can never
    // stall connecting
    this.realDeviceReady = this.fetchRealDevice();
    if (opts.autoConnect !== false) {
      const cap = new Promise<void>((resolve) => setTimeout(resolve, 300));
      Promise.race([this.realDeviceReady, cap]).then(() => this.ws.connect());
    }

    if (opts.hideUI) {
      this.hideUIWhenReady();
    }
  }

  // -------------------------------------------------------------------------
  // session
  // -------------------------------------------------------------------------

  /**
   * Device fingerprint -> stable sessionId (per user request): the same
   * physical device always maps to the same session id, so list_sessions
   * can tell devices apart and a page reload reuses the session history.
   * Two pages on ONE device share the id; the server kicks the older one.
   */
  /**
   * User-agent reduction freezes the UA model to "K" on Android Chromium, so
   * the UA-parsed label can't tell devices apart. Ask the (fast, local) client
   * hints API for the real model + platform version and surface it as
   * deviceName; user-specified deviceName always wins. Any failure is silent —
   * the label just falls back to the UA parse.
   */
  private async fetchRealDevice(): Promise<void> {
    const real: RealDeviceHints = {};
    // an iPad in "desktop site" mode reports a plain Macintosh UA and client
    // hints give no model for it — touch points are the only signal left, so
    // report them even in environments without userAgentData
    if (navigator.maxTouchPoints > 0) { real.isTablet = true; }
    try {
      const uad = (<any>navigator).userAgentData;
      if (uad && uad.platform === 'Android' && typeof uad.getHighEntropyValues === 'function') {
        const hints = await uad.getHighEntropyValues(['model', 'platformVersion']);
        const model = hints && typeof hints.model === 'string' ? hints.model.trim() : '';
        if (model && model.toUpperCase() !== 'K') {
          real.model = model;
          real.osVersion = hints && typeof hints.platformVersion === 'string' ? hints.platformVersion : '';
        }
      }
    } catch (e) {
      // ignore: the label falls back to the UA parse
    }
    if (real.model || real.isTablet) { this.realDevice = real; }
  }

  private genSessionId(): string {
    let fp = '';
    try {
      const nav = navigator as any;
      const screen = window.screen || { width: 0, height: 0 };
      // NOTE: no DPR/viewport here on purpose — those vary per tab/window;
      // the fingerprint must be a pure DEVICE identity so all pages on one
      // device share one session (the server kicks superseded pages).
      fp = [
        nav.userAgent || '',
        nav.platform || '',
        `${screen.width}x${screen.height}`,
        nav.deviceMemory || '',
        nav.maxTouchPoints != null ? String(nav.maxTouchPoints) : '',
      ].join('|');
    } catch (e) {
      fp = String(Math.random());
    }
    return `dev-${fnv1a32(fp)}`;
  }

  private onOpen() {
    // full replay; server dedupes by id on reconnect
    this.logCursor = 0;
    this.networkCursor = 0;
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      deviceName: this.opts.deviceName,
      realDevice: this.realDevice,
      probeVersion: this.vConsole.version || 'unknown',
      page: getPageInfo(),
    });
    this.scheduleFlush(0);
  }

  private hideUIWhenReady() {
    const tryHide = () => {
      if (this.vConsole.isInited) {
        this.vConsole.hideSwitch();
        this.vConsole.hide();
      } else {
        setTimeout(tryHide, 200);
      }
    };
    tryHide();
  }

  // -------------------------------------------------------------------------
  // taps
  // -------------------------------------------------------------------------

  private tapLogs() {
    const model = VConsoleLogModel.getSingleton(VConsoleLogModel, 'VConsoleLogModel');
    const self = this;

    // Note: bindPlugin may have ALREADY run for built-in plugins (their
    // constructors call it before the bridge patches it), so subscribe to
    // existing stores immediately, and patch bindPlugin for later ones.
    const subscribeStore = (pluginId: string) => {
      const store = LogStore.get(pluginId);
      if (store && !(<any>store).__mcpSubscribed) {
        (<any>store).__mcpSubscribed = true;
        // svelte subscribe fires immediately with current content, which
        // back-fills logs that predate the bridge
        store.subscribe((s) => self.onLogStoreUpdate(s.logList || []));
      }
    };

    const added = (<any>model).ADDED_LOG_PLUGIN_ID;
    if (Array.isArray(added)) {
      for (const pluginId of added) {
        subscribeStore(pluginId);
      }
    }

    const origBindPlugin = model.bindPlugin;
    model.bindPlugin = function (pluginId: string) {
      const ret = origBindPlugin.call(this, pluginId);
      subscribeStore(pluginId);
      return ret;
    };
  }

  private onLogStoreUpdate(logList: IVConsoleLog[]) {
    if (logList.length === 0) {
      if (this.logBuffer.length > 0) {
        this.logBuffer.length = 0;
        this.logCursor = 0;
        this.sentLogRepeated.clear();
        this.resetPending.logs = true;
        this.scheduleFlush();
      }
      return;
    }

    for (const log of logList) {
      const sentRepeated = this.sentLogRepeated.get(log._id);
      if (sentRepeated === undefined) {
        this.sentLogRepeated.set(log._id, log.repeated);
        this.appendLog(this.toLogItem(log));
      } else if (sentRepeated !== log.repeated) {
        this.sentLogRepeated.set(log._id, log.repeated);
        this.appendLog(this.toLogItem(log));
      }
    }
    if (this.sentLogRepeated.size > SENT_REPEAT_MAP_CAP) {
      this.sentLogRepeated.clear();
    }
    this.scheduleFlush();
  }

  private appendLog(item: LogItem) {
    this.logBuffer.push(item);
    if (this.logBuffer.length > this.maxBuffer) {
      const drop = this.logBuffer.length - this.maxBuffer;
      this.logBuffer.splice(0, drop);
      this.logCursor = Math.max(0, this.logCursor - drop);
    }
  }

  private appendNetwork(item: NetworkItem) {
    // replace a previous snapshot of the same request to keep the buffer small
    for (let i = this.networkBuffer.length - 1; i >= 0 && i >= this.networkBuffer.length - 50; i--) {
      if (this.networkBuffer[i].id === item.id) {
        this.networkBuffer.splice(i, 1);
        if (this.networkCursor > i) { this.networkCursor--; }
        break;
      }
    }
    this.networkBuffer.push(item);
    if (this.networkBuffer.length > this.maxBuffer) {
      const drop = this.networkBuffer.length - this.maxBuffer;
      this.networkBuffer.splice(0, drop);
      this.networkCursor = Math.max(0, this.networkCursor - drop);
    }
  }

  private toLogItem(log: IVConsoleLog): LogItem {
    return {
      id: log._id,
      type: log.type,
      cmdType: log.cmdType,
      repeated: log.repeated,
      date: log.date,
      args: serializeArgs((log.data || []).map((d) => d.origData)),
      groupLevel: log.groupLevel,
    };
  }

  private tapNetwork() {
    const model = VConsoleNetworkModel.getSingleton(VConsoleNetworkModel, 'VConsoleNetworkModel');
    const self = this;

    // keep the bridge's own WebSocket connection out of captured traffic
    // (it would otherwise show up in every get_network)
    try {
      const httpish = this.opts.serverUrl.replace(/^ws(s?):/, 'http$1:');
      const host = new URL(httpish).host;
      const source = `^[a-z]+://${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      const prev = (<any>model).ignoreUrlRegExp;
      model.ignoreUrlRegExp = prev ? new RegExp(prev.source + '|' + source, 'i') : new RegExp(source, 'i');
    } catch (e) {
      // non-fatal: worst case the bridge connection appears in the capture
    }

    const origUpdateRequest = model.updateRequest;
    model.updateRequest = function (id: string, data: VConsoleNetworkRequestItem) {
      const ret = origUpdateRequest.call(this, id, data);
      // origUpdateRequest drops ignoreUrlRegExp matches from the on-page UI,
      // but returns normally — skip those here too, or the bridge's own
      // WebSocket connection pollutes every get_network answer
      const re = this.ignoreUrlRegExp;
      if (!(re && data.url && re.test(data.url))) {
        self.appendNetwork(self.toNetworkItem(data));
        self.scheduleFlush();
      }
      return ret;
    };

    const origClearLog = model.clearLog;
    model.clearLog = function () {
      const ret = origClearLog.call(this);
      self.networkBuffer.length = 0;
      self.networkCursor = 0;
      self.resetPending.network = true;
      self.scheduleFlush();
      return ret;
    };
  }

  private toNetworkItem(item: VConsoleNetworkRequestItem): NetworkItem {
    return {
      id: item.id,
      requestType: item.requestType,
      method: item.method || '',
      url: item.url || '',
      name: item.name,
      status: item.status,
      statusText: item.statusText,
      readyState: item.readyState,
      cancelState: item.cancelState,
      requestHeader: item.requestHeader ? serializeOne(item.requestHeader) : undefined,
      responseHeader: item.header ? serializeOne(item.header) : undefined,
      postData: item.postData != null ? serializeOne(item.postData) : undefined,
      response: item.response != null ? serializeOne(item.response) : undefined,
      responseType: item.responseType,
      responseSize: item.responseSize,
      getData: item.getData ? serializeOne(item.getData) : undefined,
      startTime: item.startTime,
      endTime: item.endTime,
      costTime: item.costTime,
      transferSize: item.transferSize,
      replayedFrom: item.replayedFrom,
      messages: item.messages ? item.messages.map((m) => ({
        type: m.type,
        data: serializeOne(m.data),
        time: m.time,
      })) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // console integrity guard
  // -------------------------------------------------------------------------

  /**
   * Some SDKs (monitoring/analytics) and embedded webview hosts rewrap
   * `window.console` AFTER vConsole has mocked it, silently cutting the
   * bridge off from logs. Poll for the mock marker and re-apply the hook.
   */
  private startConsoleGuard() {
    const interval = setInterval(() => {
      const cur = window.console && window.console.log;
      if (cur && (<any>cur).__vcmMock) {
        return;
      }
      try {
        const model = VConsoleLogModel.getSingleton(VConsoleLogModel, 'VConsoleLogModel');
        if (model && (<any>model.origConsole)) {
          // force mockConsole to re-run: it early-returns when origConsole.log exists
          (<any>model.origConsole).log = undefined;
          model.mockConsole();
        }
      } catch (e) {
        // keep guarding silently
      }
    }, 2000);
    // never keep the page alive just for the guard
    (<any>interval).unref?.();
  }

  // -------------------------------------------------------------------------
  // batching & sending
  // -------------------------------------------------------------------------

  private scheduleFlush(delay = FLUSH_INTERVAL_MS) {
    if (this.flushTimer !== null) { return; }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush() {
    if (this.resetPending.network) {
      this.resetPending.network = false;
      this.send({ type: 'network', items: [], reset: true });
    }
    if (this.resetPending.logs) {
      this.resetPending.logs = false;
      this.send({ type: 'logs', items: [], reset: true });
    }

    while (this.networkCursor < this.networkBuffer.length) {
      const end = Math.min(this.networkCursor + MAX_ITEMS_PER_MSG, this.networkBuffer.length);
      const batch = this.networkBuffer.slice(this.networkCursor, end);
      // when offline the wsClient queues the message; a reconnect also
      // triggers a full replay, so advancing the cursor is always safe
      this.send({ type: 'network', items: batch });
      this.networkCursor = end;
    }
    while (this.logCursor < this.logBuffer.length) {
      const end = Math.min(this.logCursor + MAX_ITEMS_PER_MSG, this.logBuffer.length);
      const batch = this.logBuffer.slice(this.logCursor, end);
      this.send({ type: 'logs', items: batch });
      this.logCursor = end;
    }
  }

  /** Oversized single messages are dropped; items stay in the buffer for later queries. */
  private send(msg: ProbeMessage): boolean {
    const json = JSON.stringify(msg);
    if (json.length > MAX_MSG_BYTES) {
      return true;
    }
    return this.ws.send(json);
  }

  // -------------------------------------------------------------------------
  // commands
  // -------------------------------------------------------------------------

  private onServerMessage(data: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') { return; }

    if (msg.type === 'kick') {
      this.onKicked();
      return;
    }

    if (msg.type === 'cmd') {
      this.runCommand(msg.reqId, msg.cmd, msg.args || {});
    }
    // 'ping' needs no explicit answer
  }

  /**
   * Another page on this device (same fingerprint) took over the session.
   * Back off and stop reconnecting; try again when this page becomes
   * visible again (the user switched back to it).
   */
  private onKicked() {
    if (this.kickResumeHandler) { return; }
    this.ws.close();
    const onVis = () => {
      if (document.hidden) { return; }
      document.removeEventListener('visibilitychange', this.kickResumeHandler!);
      this.kickResumeHandler = null;
      this.ws.resume();
    };
    this.kickResumeHandler = onVis;
    document.addEventListener('visibilitychange', onVis);
  }

  private async runCommand(reqId: string, cmd: string, args: Record<string, any>) {
    try {
      let data: unknown;
      switch (cmd) {
        case 'eval':
          data = evalExpression(String(args.expression || ''));
          break;
        case 'get_dom':
          data = getDom(String(args.selector || 'body'), args.limit ? Number(args.limit) : undefined);
          break;
        case 'get_storage':
          data = getStorage();
          break;
        case 'set_storage':
          data = setStorage(
            args.storage as StorageKind,
            String(args.key || ''),
            args.value === undefined ? '' : String(args.value),
          );
          break;
        case 'del_storage':
          data = delStorage(args.storage as StorageKind, String(args.key || ''));
          break;
        case 'page_info':
          data = getPageInfo();
          break;
        case 'replay':
          data = await replay(<{ requestId: string }>args);
          break;
        case 'screenshot':
          data = await screenshot({
            format: args.format === 'jpeg' ? 'jpeg' : 'png',
            scale: args.scale ? Number(args.scale) : undefined,
            assetUrl: this.assetUrl,
          });
          break;
        default:
          throw new Error(`unknown command: ${cmd}`);
      }
      this.sendResult(reqId, true, data);
    } catch (e: any) {
      // bare message: `ok:false` already marks it as a failure, and every consumer
      // (hub tool result, panel) adds its own "Error:" framing on top
      this.sendResult(reqId, false, undefined, `${(e && e.message) || String(e)}`);
    }
  }

  private sendResult(reqId: string, ok: boolean, data?: unknown, error?: string) {
    this.send({ type: 'result', reqId, ok, data, error });
  }
}
