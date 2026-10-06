export interface VConsoleLogOptions {
  maxLogNumber?: number;
  showTimestamps?: boolean;
}

export interface VConsoleNetworkOptions {
  maxNetworkNumber?: number;
  ignoreUrlRegExp?: RegExp;
}

export type VConsoleAvailableStorage = 'cookies' | 'localStorage' | 'sessionStorage' | 'wxStorage';
export interface VConsoleStorageOptions {
  defaultStorages?: VConsoleAvailableStorage[];
}

export interface VConsoleOptions {
  target?: string | HTMLElement;
  defaultPlugins?: ('system' | 'network' | 'element' | 'storage')[];
  theme?: '' | 'dark' | 'light';
  disableLogScrolling?: boolean;
  pluginOrder?: string[];
  onReady?: () => void;

  log?: VConsoleLogOptions,
  network?: VConsoleNetworkOptions,
  storage?: VConsoleStorageOptions,

  /**
   * MCP bridge (fork addition): the WebSocket endpoint of the MCP server,
   * e.g. ws://192.168.x.x:9528. When set, the probe streams logs/network
   * data to the server and accepts commands from AI agents.
   */
  serverUrl?: string,
  /** optional human-readable label; auto-derived from the device fingerprint when omitted */
  deviceName?: string,
  /** set false to keep collecting data but never connect (default: true) */
  autoConnect?: boolean,
  /** hide the vConsole switch button + panel for agent-only usage (default: false) */
  hideUI?: boolean,
  /** max buffered log/network items kept for (re)delivery, per stream (default: 2000) */
  maxBuffer?: number,

  /**
   * @deprecated Since v3.12.0, use `log.maxLogNumber`.
   */
  maxLogNumber?: number;
  /**
   * @deprecated Since v3.12.0, use `network.maxNetworkNumber`.
   */
  maxNetworkNumber?: number;
  /**
   * @deprecated Since v3.12.0.
   */
  onClearLog?: () => void;
}
