/**
 * Reconnecting WebSocket client for the MCP bridge.
 *
 * - the session id is appended to the URL as a query param
 * - auto-reconnect with capped exponential backoff + jitter
 * - outgoing messages are queued while offline (bounded by maxBuffer)
 */

export interface WSClientOptions {
  url: string;
  sessionId: string;
  maxQueue?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (data: string) => void;
  onStatus?: (status: WSStatus) => void;
}

export type WSStatus = 'connecting' | 'open' | 'closed';

export class WSClient {
  private opts: WSClientOptions;
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private retryCount = 0;
  private retryTimer: any = null;
  private closedByUs = false;
  public status: WSStatus = 'closed';

  constructor(opts: WSClientOptions) {
    this.opts = opts;
    this.maxQueue = opts.maxQueue || 2000;
  }

  private maxQueue: number;

  public connect() {
    if (this.closedByUs) { return; }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    const sep = this.opts.url.indexOf('?') > -1 ? '&' : '?';
    const url = `${this.opts.url}${sep}sid=${encodeURIComponent(this.opts.sessionId)}`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.scheduleRetry();
      return;
    }
    this.ws.onopen = () => {
      this.retryCount = 0;
      this.setStatus('open');
      this.drain();
      if (this.opts.onOpen) { this.opts.onOpen(); }
    };
    this.ws.onmessage = (ev) => {
      if (this.opts.onMessage && typeof ev.data === 'string') {
        this.opts.onMessage(ev.data);
      }
    };
    this.ws.onclose = () => {
      this.setStatus('closed');
      if (this.opts.onClose) { this.opts.onClose(); }
      if (!this.closedByUs) {
        this.scheduleRetry();
      }
    };
    this.ws.onerror = () => {
      // onclose follows; nothing to do here
    };
  }

  private setStatus(s: WSStatus) {
    this.status = s;
    if (this.opts.onStatus) { this.opts.onStatus(s); }
  }

  private scheduleRetry() {
    if (this.closedByUs) { return; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); }
    const base = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    const delay = base / 2 + Math.random() * base / 2;
    this.retryCount++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Queue a message; drops the OLDEST queued message when the queue is full. */
  public send(data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
        return true;
      } catch (e) {
        // fall through to queueing
      }
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
    }
    this.queue.push(data);
    return false;
  }

  private drain() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    while (this.queue.length > 0) {
      const msg = this.queue.shift();
      try {
        this.ws.send(msg);
      } catch (e) {
        this.queue.unshift(msg);
        return;
      }
    }
  }

  public close() {
    this.closedByUs = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch (e) { /* noop */ }
      this.ws = null;
    }
    this.setStatus('closed');
  }

  /** Reconnect after a deliberate close (e.g. resume after being kicked). */
  public resume() {
    this.closedByUs = false;
    this.connect();
  }
}
