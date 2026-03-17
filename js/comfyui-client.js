/**
 * ComfyUI REST + WebSocket Client
 * Handles all communication with the ComfyUI backend.
 */
import CONFIG from './config.js';

export class ComfyUIClient {
  constructor(serverUrl = CONFIG.comfyuiUrl) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.clientId = crypto.randomUUID();
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.listeners = {
      status: [],
      executing: [],
      progress: [],
      executed: [],
      error: [],
      connection: [],
    };
  }

  /**
   * Register a callback for a specific message type.
   */
  on(type, callback) {
    if (this.listeners[type]) {
      this.listeners[type].push(callback);
    }
  }

  /**
   * Remove a callback for a specific message type.
   */
  off(type, callback) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
    }
  }

  _emit(type, data) {
    if (this.listeners[type]) {
      for (const cb of this.listeners[type]) {
        cb(data);
      }
    }
  }

  /**
   * Connect to the ComfyUI WebSocket.
   */
  connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.serverUrl.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(new Error(`Failed to create WebSocket: ${err.message}`));
        return;
      }

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this._emit('connection', { connected: true });
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const { type, data } = message;
          if (type && this.listeners[type]) {
            this._emit(type, data);
          }
        } catch (err) {
          // Ignore non-JSON messages (e.g., binary preview frames)
        }
      };

      this.ws.onerror = (event) => {
        this._emit('error', { message: 'WebSocket error' });
      };

      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._emit('connection', { connected: false });

        if (wasConnected && this.reconnectAttempts < CONFIG.wsMaxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => {
            this.connectWebSocket().catch(() => {});
          }, CONFIG.wsReconnectInterval);
        }
      };

      // Timeout if connection doesn't open
      setTimeout(() => {
        if (!this.connected) {
          this.ws.close();
          reject(new Error('WebSocket connection timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Disconnect the WebSocket.
   */
  disconnect() {
    this.reconnectAttempts = CONFIG.wsMaxReconnectAttempts; // Prevent auto-reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Queue a workflow prompt on ComfyUI.
   * POST /prompt
   */
  async queuePrompt(workflow) {
    const payload = {
      prompt: workflow,
      client_id: this.clientId,
    };

    const response = await fetch(`${this.serverUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to queue prompt: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    return result.prompt_id;
  }

  /**
   * Get workflow execution history/results.
   * GET /history/{prompt_id}
   */
  async getHistory(promptId) {
    const response = await fetch(`${this.serverUrl}/history/${promptId}`);
    if (!response.ok) {
      throw new Error(`Failed to get history: ${response.status}`);
    }
    const history = await response.json();
    return history[promptId];
  }

  /**
   * Retrieve a generated file (image or mesh).
   * GET /view?filename=...
   */
  async getFile(filename, subfolder = '', type = 'output') {
    const params = new URLSearchParams({ filename, subfolder, type });
    const response = await fetch(`${this.serverUrl}/view?${params}`);
    if (!response.ok) {
      throw new Error(`Failed to retrieve file: ${response.status}`);
    }
    return response;
  }

  /**
   * Get a generated image as a blob URL.
   */
  async getImageUrl(filename, subfolder = '', type = 'output') {
    const response = await this.getFile(filename, subfolder, type);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Get a generated GLB mesh as an ArrayBuffer.
   */
  async getMeshData(filename, subfolder = '', type = 'output') {
    const response = await this.getFile(filename, subfolder, type);
    return response.arrayBuffer();
  }

  /**
   * Wait for a prompt to finish executing.
   * Returns the output data from the history.
   */
  waitForCompletion(promptId) {
    return new Promise((resolve, reject) => {
      const onExecuting = (data) => {
        // When data.node is null, execution is complete
        if (data && data.node === null && data.prompt_id === promptId) {
          cleanup();
          // Small delay to ensure history is available
          setTimeout(async () => {
            try {
              const history = await this.getHistory(promptId);
              if (history && history.outputs) {
                resolve(history.outputs);
              } else {
                reject(new Error('No outputs found in history'));
              }
            } catch (err) {
              reject(err);
            }
          }, 500);
        }
      };

      const onError = (data) => {
        cleanup();
        reject(new Error(data.message || 'Execution error'));
      };

      const cleanup = () => {
        this.off('executing', onExecuting);
        this.off('error', onError);
      };

      this.on('executing', onExecuting);
      this.on('error', onError);
    });
  }

  /**
   * Check if the ComfyUI server is reachable.
   */
  async checkConnection() {
    try {
      const response = await fetch(`${this.serverUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Update the server URL and reconnect.
   */
  async setServerUrl(url) {
    this.disconnect();
    this.serverUrl = url.replace(/\/$/, '');
    this.reconnectAttempts = 0;
  }
}
