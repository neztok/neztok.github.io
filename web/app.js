const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
  : null;

const state = {
  question: null,
  fullText: '',
  pages: [],
  pageIndex: 0,
  typedLength: 0,
  cps: 14,
  pauseFactor: 1.0,
  zoom: 1.1,
  compact: true,
  running: false,
  phraseIndex: 0,
  requestedChunks: new Set(),
  ttsControllers: new Map(),
  currentAudioId: null,
  autoScroll: false,
  statusHint: '',
};

const FONT_SCALES = [1, 26 / 28, 24 / 28, 22 / 28];

let elements = {};
let statusFrameToken = null;
let readyNotified = false;

const params = new URLSearchParams(window.location.search || '');
const bridgeMode = (params.get('mode') || 'ws').toLowerCase();
const bridgePort = Number.parseInt(params.get('port') || '8765', 10);
const bridgeWsUrl = `ws://127.0.0.1:${bridgePort}/presentation`;
const bridgeHttpBase = `http://127.0.0.1:${bridgePort}`;

function createWebSocketBridge(url) {
  const listeners = new Set();
  const openListeners = new Set();
  let socket = null;
  let ready = false;
  const queue = [];

  function notifyOpen() {
    ready = true;
    openListeners.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('bridge open handler failed', err);
      }
    });
  }

  function notifyMessage(data) {
    listeners.forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error('bridge message handler failed', err);
      }
    });
  }

  function connect(delay = 0) {
    if (socket) {
      try {
        socket.close();
      } catch (err) {
        // ignore close errors
      }
    }
    setTimeout(() => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        const pending = queue.splice(0);
        pending.forEach((msg) => socket.send(msg));
        notifyOpen();
      };
      socket.onmessage = (event) => {
        notifyMessage(event.data);
      };
      socket.onerror = () => {
        if (socket) {
          try {
            socket.close();
          } catch (err) {
            // ignore
          }
        }
      };
      socket.onclose = () => {
        ready = false;
        connect(500);
      };
    }, delay);
  }

  connect();

  return {
    send(message) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else {
        queue.push(payload);
      }
    },
    onMessage(callback) {
      if (typeof callback === 'function') {
        listeners.add(callback);
      }
    },
    onOpen(callback) {
      if (typeof callback === 'function') {
        openListeners.add(callback);
        if (socket && socket.readyState === WebSocket.OPEN) {
          callback();
        }
      }
    },
  };
}

function createHttpBridge(baseUrl) {
  const listeners = new Set();
  const openListeners = new Set();
  let source = null;

  function notifyOpen() {
    openListeners.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('bridge open handler failed', err);
      }
    });
  }

  function notifyMessage(data) {
    listeners.forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error('bridge message handler failed', err);
      }
    });
  }

  function connect(delay = 0) {
    if (source) {
      try {
        source.close();
      } catch (err) {
        // ignore
      }
    }
    setTimeout(() => {
      source = new EventSource(`${baseUrl}/api/presentation/events`, { withCredentials: false });
      source.onopen = () => {
        notifyOpen();
      };
      source.onmessage = (event) => {
        notifyMessage(event.data);
      };
      source.onerror = () => {
        try {
          source.close();
        } catch (err) {
          // ignore
        }
        connect(1000);
      };
    }, delay);
  }

  connect();

  return {
    send(message) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      fetch(`${baseUrl}/api/presentation`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).catch((err) => {
        console.error('bridge http send failed', err);
      });
    },
    onMessage(callback) {
      if (typeof callback === 'function') {
        listeners.add(callback);
      }
    },
    onOpen(callback) {
      if (typeof callback === 'function') {
        openListeners.add(callback);
      }
    },
  };
}

let bridgeConnection = null;
let bridgeReceiver = null;
let pendingBridgeMessages = [];

function ensureBridge() {
  if (!bridgeConnection) {
    bridgeConnection = bridgeMode === 'http' ? createHttpBridge(bridgeHttpBase) : createWebSocketBridge(bridgeWsUrl);
    bridgeConnection.onMessage((message) => {
      if (bridgeReceiver) {
        bridgeReceiver(message);
      } else {
        pendingBridgeMessages.push(message);
      }
    });
    bridgeConnection.onOpen(() => {
      notifyReady();
    });
  }
  return bridgeConnection;
}

function setBridgeReceiver(handler) {
  bridgeReceiver = handler;
  if (pendingBridgeMessages.length && typeof handler === 'function') {
    const queued = pendingBridgeMessages.splice(0);
    queued.forEach((message) => {
      try {
        handler(message);
      } catch (err) {
        console.error('bridge queued message failed', err);
      }
    });
  }
}

function sendCommand(action, data = {}) {
  const bridge = ensureBridge();
  bridge.send({ action, data });
}

function segmentGraphemes(text) {
  if (!segmenter) {
    return Array.from(text);
  }
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function estimateLines(text, approx = 28) {
  return text.split('\n').reduce((sum, line) => {
    const length = line.length || 1;
    return sum + Math.max(1, Math.ceil(length / approx));
  }, 0);
}

function findBreak(fullText, start, end) {
  for (let idx = end - 1; idx > start; idx -= 1) {
    const char = fullText[idx];
    if ('。．.!?！？\n'.includes(char)) {
      return idx + 1;
    }
  }
  for (let idx = end - 1; idx > start; idx -= 1) {
    const char = fullText[idx];
    if ('、，,'.includes(char)) {
      return idx + 1;
    }
  }
  return end;
}

function computePhrases(text) {
  const phrases = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ('。．!?！？\n'.includes(char)) {
      phrases.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) {
    phrases.push({ start, end: text.length });
  }
  if (!phrases.length) {
    phrases.push({ start: 0, end: text.length });
  }
  return phrases;
}

function createPage(fullText, start, end) {
  const text = fullText.slice(start, end);
  return {
    start,
    end,
    text,
    graphemes: segmentGraphemes(text),
    phrases: computePhrases(text),
  };
}

function paginate(fullText) {
  if (!fullText) {
    return [createPage('', 0, 0)];
  }
  const pages = [];
  const approxLine = 28;
  const maxLines = 10;
  const charLimit = approxLine * maxLines;
  let cursor = 0;
  while (cursor < fullText.length) {
    let end = Math.min(cursor + charLimit, fullText.length);
    let slice = fullText.slice(cursor, end);
    let lines = estimateLines(slice, approxLine);
    let guard = 0;
    while (lines > maxLines && end > cursor && guard < 10) {
      const candidate = findBreak(fullText, cursor, end - approxLine);
      if (candidate <= cursor) {
        end = Math.max(cursor + approxLine, end - approxLine);
      } else {
        end = candidate;
      }
      slice = fullText.slice(cursor, end);
      lines = estimateLines(slice, approxLine);
      guard += 1;
    }
    if (end < fullText.length) {
      const pleasant = findBreak(fullText, cursor, end);
      if (pleasant > cursor) {
        end = pleasant;
        slice = fullText.slice(cursor, end);
      }
    }
    if (end <= cursor) {
      end = Math.min(cursor + approxLine, fullText.length);
      slice = fullText.slice(cursor, end);
    }
    pages.push(createPage(fullText, cursor, end));
    cursor = end;
  }
  return pages;
}

function currentPage() {
  return state.pages[state.pageIndex] || null;
}

function setFontScale(scale) {
  document.documentElement.style.setProperty('--font-scale', scale);
}

function applyZoom(value) {
  state.zoom = value;
  document.documentElement.style.setProperty('--zoom', value);
  if (elements.app) {
    elements.app.dataset.zoom = value.toFixed(2);
  }
  updateSettingsHint();
  scheduleStatus();
}

function setCompact(value) {
  state.compact = value;
  if (elements.app) {
    elements.app.classList.toggle('compact', value);
  }
}

function setStatusHint(message) {
  state.statusHint = message || '';
  updateSettingsHint();
}

function updateSettingsHint() {
  if (!elements.status) return;
  const base = `CPS ${state.cps}｜ポーズ ${state.pauseFactor.toFixed(2)}｜ズーム ${state.zoom.toFixed(2)}`;
  elements.status.textContent = state.statusHint ? `${state.statusHint} ／ ${base}` : base;
}

function updatePageIndicator() {
  if (!elements.pageIndicator) return;
  const total = state.pages.length || 1;
  elements.pageIndicator.textContent = `${state.pageIndex + 1}/${total}`;
}

async function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function fitContent(page) {
  if (!page || !elements.content || !elements.contentShell) return;
  const previous = elements.content.textContent;
  elements.content.textContent = page.text;
  state.autoScroll = false;
  elements.contentShell.classList.remove('auto-scroll');
  for (const scale of FONT_SCALES) {
    setFontScale(scale);
    await nextFrame();
    if (elements.content.scrollHeight <= elements.contentShell.clientHeight) {
      elements.contentShell.scrollTop = 0;
      elements.content.textContent = previous;
      return;
    }
  }
  const smallest = FONT_SCALES[FONT_SCALES.length - 1];
  setFontScale(smallest);
  await nextFrame();
  if (elements.content.scrollHeight > elements.contentShell.clientHeight) {
    state.autoScroll = true;
    elements.contentShell.classList.add('auto-scroll');
  }
  elements.content.textContent = previous;
}

function setDisplayedText(page, length) {
  if (!elements.content) return;
  const slice = page.graphemes.slice(0, length).join('');
  elements.content.textContent = slice;
}

function updateScroll(page) {
  if (!state.autoScroll || !elements.contentShell || !elements.content) return;
  const maxScroll = elements.content.scrollHeight - elements.contentShell.clientHeight;
  if (maxScroll <= 0) {
    elements.contentShell.scrollTop = 0;
    return;
  }
  const total = page.graphemes.length || 1;
  const ratio = Math.min(1, state.typedLength / total);
  elements.contentShell.scrollTop = maxScroll * ratio;
}

function cancelAllTtsRequests() {
  for (const controller of state.ttsControllers.values()) {
    try {
      controller.abort();
    } catch (err) {
      // Ignore abort errors
    }
  }
  state.ttsControllers.clear();
}

function resetTtsPrefetch(options = {}) {
  const { flushAudio = false } = options;
  if (flushAudio) {
    audioManager.flush();
  }
  cancelAllTtsRequests();
  state.requestedChunks.clear();
  state.currentAudioId = null;
  scheduleStatus();
}

function requestAudioForUpcoming() {
  const page = currentPage();
  if (!page) return;
  const ahead = 3;
  for (let offset = 0; offset < ahead; offset += 1) {
    const index = state.phraseIndex + offset;
    if (index >= page.phrases.length) continue;
    const phrase = page.phrases[index];
    if (!phrase || phrase.end <= phrase.start) continue;
    const chunkId = `${state.pageIndex}-${index}`;
    if (state.requestedChunks.has(chunkId)) continue;
    state.requestedChunks.add(chunkId);
    const controller = new AbortController();
    state.ttsControllers.set(chunkId, controller);
    sendCommand('TTS_REQUEST', {
      slice: [
        {
          id: chunkId,
          startChar: page.start + phrase.start,
          endChar: page.start + phrase.end,
        },
      ],
    });
    controller.signal.addEventListener('abort', () => {
      state.requestedChunks.delete(chunkId);
      state.ttsControllers.delete(chunkId);
    });
  }
}

function updatePhraseProgress(page) {
  let completed = 0;
  for (let i = 0; i < page.phrases.length; i += 1) {
    if (state.typedLength >= page.phrases[i].end) {
      completed = i + 1;
    } else {
      break;
    }
  }
  if (completed !== state.phraseIndex) {
    state.phraseIndex = completed;
    requestAudioForUpcoming();
  }
}

function scheduleStatus() {
  if (statusFrameToken) return;
  statusFrameToken = requestAnimationFrame(() => {
    statusFrameToken = null;
    sendStatus();
  });
}

function sendStatus() {
  const payload = {
    page: state.pageIndex + 1,
    totalPages: state.pages.length || 1,
    phraseIndex: Math.max(1, state.phraseIndex + 1),
    ttsQueue: audioManager.queueLength(),
  };
  sendCommand('STATUS', payload);
}

function flashOverlay() {
  if (!elements.overlay) return;
  elements.overlay.classList.add('active');
  setTimeout(() => {
    elements.overlay.classList.remove('active');
  }, 120);
}

function clearAnswerPanel() {
  document.body.classList.remove('show-answer');
}

function populateAnswerPanel(question) {
  if (elements.answers) {
    elements.answers.textContent = (question.answers || []).join(' / ');
  }
  if (elements.explain) {
    elements.explain.textContent = question.explain || '';
  }
}

const audioManager = {
  context: null,
  queue: [],
  currentSource: null,
  playing: false,

  getContext() {
    if (this.context) {
      return this.context;
    }
    if (typeof AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') {
      return null;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.context = new Ctor();
    return this.context;
  },

  ensureContext() {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  },

  async enqueue(id, base64) {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      this.ensureContext();
      const buffer = await ctx.decodeAudioData(base64ToArrayBuffer(base64));
      this.queue.push({ id, buffer });
      this.playNext();
    } catch (err) {
      reportError('audio_decode_failed', err);
    }
    scheduleStatus();
  },

  playNext() {
    if (this.playing) {
      return;
    }
    const ctx = this.getContext();
    if (!ctx) return;
    const next = this.queue.shift();
    if (!next) {
      state.currentAudioId = null;
      scheduleStatus();
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = next.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      this.playing = false;
      this.currentSource = null;
      state.currentAudioId = null;
      this.playNext();
    };
    this.currentSource = source;
    this.playing = true;
    state.currentAudioId = next.id || null;
    try {
      source.start();
    } catch (err) {
      this.playing = false;
      this.currentSource = null;
      state.currentAudioId = null;
      reportError('audio_start_failed', err);
    }
    scheduleStatus();
  },

  flush() {
    this.stopCurrent();
    this.queue = [];
    state.currentAudioId = null;
    scheduleStatus();
  },

  stopCurrent() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (err) {
        reportError('audio_stop_failed', err);
      }
      this.currentSource.disconnect();
      this.currentSource = null;
      this.playing = false;
    }
    state.currentAudioId = null;
  },

  queueLength() {
    return this.queue.length + (this.playing ? 1 : 0);
  },
};

const typewriter = {
  rafId: null,
  running: false,
  lastTimestamp: 0,

  start(fromIndex = 0) {
    const page = currentPage();
    if (!page) return;
    this.stop();
    state.typedLength = Math.max(0, Math.min(fromIndex, page.graphemes.length));
    state.phraseIndex = 0;
    setDisplayedText(page, state.typedLength);
    updateScroll(page);
    this.running = true;
    this.lastTimestamp = performance.now();
    audioManager.ensureContext();
    requestAudioForUpcoming();
    this.rafId = requestAnimationFrame(this.step.bind(this));
    setStatusHint('進行中');
    scheduleStatus();
  },

  resume() {
    const page = currentPage();
    if (!page) return;
    if (this.running || state.typedLength >= page.graphemes.length) {
      return;
    }
    this.running = true;
    this.lastTimestamp = performance.now();
    audioManager.ensureContext();
    requestAudioForUpcoming();
    this.rafId = requestAnimationFrame(this.step.bind(this));
    setStatusHint('再開');
    scheduleStatus();
  },

  stop(withFlash = false) {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.running = false;
    if (withFlash) {
      flashOverlay();
    }
  },

  step(timestamp) {
    if (!this.running) {
      return;
    }
    const page = currentPage();
    if (!page) {
      this.stop();
      return;
    }
    if (state.typedLength >= page.graphemes.length) {
      this.stop();
      setStatusHint('完了');
      scheduleStatus();
      return;
    }
    if (!this.lastTimestamp) {
      this.lastTimestamp = timestamp;
    }
    const delay = computeDelay(page, state.typedLength);
    if (timestamp - this.lastTimestamp >= delay) {
      state.typedLength += 1;
      setDisplayedText(page, state.typedLength);
      updatePhraseProgress(page);
      updateScroll(page);
      scheduleStatus();
      this.lastTimestamp = timestamp;
    }
    this.rafId = requestAnimationFrame(this.step.bind(this));
  },
};

function computeDelay(page, index) {
  const char = page.graphemes[index] || '';
  const next = page.graphemes[index + 1] || '';
  const base = 1000 / Math.max(1, state.cps);
  let extra = 0;
  if ('、，,'.includes(char)) {
    extra += 120;
  }
  if ('。．!?！？'.includes(char)) {
    extra += 200;
  }
  if (char === '\n' && next === '\n') {
    extra += 300;
  }
  return (base + extra) * state.pauseFactor;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function setPage(index, options = {}) {
  if (!state.pages.length) {
    state.pages = [createPage('', 0, 0)];
  }
  const target = Math.max(0, Math.min(index, state.pages.length - 1));
  state.pageIndex = target;
  const page = currentPage();
  typewriter.stop();
  state.typedLength = 0;
  state.phraseIndex = 0;
  resetTtsPrefetch({ flushAudio: options.flushAudio !== false });
  if (elements.content) {
    elements.content.textContent = '';
  }
  if (elements.contentShell) {
    elements.contentShell.scrollTop = 0;
  }
  updatePageIndicator();
  await fitContent(page);
  scheduleStatus();
  requestAudioForUpcoming();
}

function reportError(code, error) {
  console.error(code, error);
  const message = error && error.message ? error.message : String(error);
  sendCommand('ERROR', { code, message });
}

const handlers = {
  async load_question(data = {}) {
    state.question = data;
    state.fullText = data.text || '';
    if (elements.title) {
      elements.title.textContent = data.title || '';
    }
    populateAnswerPanel(data);
    clearAnswerPanel();
    state.pages = paginate(state.fullText);
    await setPage(0, { flushAudio: true });
    setStatusHint('待機中');
    scheduleStatus();
  },

  async start(data = {}) {
    const fromPage = Number.isInteger(data.fromPage) ? data.fromPage : state.pageIndex;
    await setPage(fromPage, { flushAudio: true });
    requestAudioForUpcoming();
    typewriter.start(0);
  },

  stop_all() {
    typewriter.stop(true);
    resetTtsPrefetch({ flushAudio: true });
    setStatusHint('停止中');
  },

  resume() {
    requestAudioForUpcoming();
    typewriter.resume();
  },

  async goto_page(data = {}) {
    const index = Number.isInteger(data.page) ? data.page : 0;
    await setPage(index, { flushAudio: true });
    setStatusHint(`ページ ${state.pageIndex + 1}`);
  },

  set_cps(data = {}) {
    if (typeof data.value === 'number') {
      state.cps = data.value;
      updateSettingsHint();
      resetTtsPrefetch({ flushAudio: true });
      requestAudioForUpcoming();
    }
  },

  set_pause_factor(data = {}) {
    if (typeof data.value === 'number') {
      state.pauseFactor = data.value;
      updateSettingsHint();
      resetTtsPrefetch({ flushAudio: true });
      requestAudioForUpcoming();
    }
  },

  set_zoom(data = {}) {
    if (typeof data.value === 'number') {
      applyZoom(data.value);
    }
  },

  set_compact(data = {}) {
    setCompact(Boolean(data.value));
  },

  reveal_answer() {
    document.body.classList.add('show-answer');
  },

  play_chunk(data = {}) {
    if (!data.wavBase64) return;
    const id = data.id || `chunk-${Date.now()}`;
    audioManager.enqueue(id, data.wavBase64);
  },

  flush_audio() {
    resetTtsPrefetch({ flushAudio: true });
  },
};

window.appBridge = {
  receive(message) {
    try {
      const payload = typeof message === 'string' ? JSON.parse(message) : message;
      if (!payload || !payload.action) {
        return;
      }
      const handler = handlers[payload.action];
      if (handler) {
        Promise.resolve(handler(payload.data || {})).catch((err) => reportError('handler_failed', err));
      }
    } catch (err) {
      reportError('receive_failed', err);
    }
  },
};

setBridgeReceiver(window.appBridge.receive);
ensureBridge();

function notifyReady() {
  if (readyNotified) return;
  readyNotified = true;
  sendCommand('READY', {});
}

document.addEventListener('DOMContentLoaded', () => {
  elements = {
    app: document.getElementById('app'),
    content: document.getElementById('content'),
    contentShell: document.getElementById('contentShell'),
    pageIndicator: document.getElementById('pageIndicator'),
    overlay: document.getElementById('overlayFlash'),
    title: document.getElementById('questionTitle'),
    status: document.getElementById('statusHint'),
    answers: document.getElementById('answers'),
    explain: document.getElementById('explain'),
  };
  applyZoom(state.zoom);
  setCompact(state.compact);
  updateSettingsHint();
  scheduleStatus();
});

window.addEventListener('error', (event) => {
  reportError('runtime_error', event.error || event.message);
});
