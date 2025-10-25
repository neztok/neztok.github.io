console.log('app.js loaded', {
  href: window.location.href,
  base: document.baseURI,
});

// Guard against using the current document URL as a resource target. Loading the
// presentation HTML as if it were a script, stylesheet, or media source causes
// the browser to reload itself endlessly (and is blocked by Chromium on
// file:/// origins). Always point to an explicit relative asset instead.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
  : null;

function createSelfUrlBlocklist() {
  const canonicalize = (value) => {
    try {
      const resolved = new URL(value, window.location.href);
      resolved.hash = '';
      const withoutSearch = new URL(resolved.href);
      withoutSearch.search = '';
      return [resolved.href, withoutSearch.href];
    } catch (err) {
      return [];
    }
  };

  const blocked = new Set();
  canonicalize(window.location.href).forEach((value) => blocked.add(value));
  canonicalize(document.baseURI).forEach((value) => blocked.add(value));
  return blocked;
}

const SELF_URL_BLOCKLIST = createSelfUrlBlocklist();

const RESOURCE_ATTR_TAGS = {
  src: new Set(['AUDIO', 'EMBED', 'IFRAME', 'IMG', 'INPUT', 'SCRIPT', 'SOURCE', 'TRACK', 'VIDEO']),
  href: new Set(['LINK']),
  data: new Set(['OBJECT']),
};

const RESOURCE_QUERY = [
  'audio[src]',
  'embed[src]',
  'iframe[src]',
  'img[src]',
  'input[src]',
  'link[href]',
  'object[data]',
  'script[src]',
  'source[src]',
  'track[src]',
  'video[src]',
].join(',');

function sanitizeResourceAttribute(element, attributeName) {
  const tagWhitelist = RESOURCE_ATTR_TAGS[attributeName];
  if (!tagWhitelist || !tagWhitelist.has(element.tagName)) {
    return;
  }

  const rawValue = element.getAttribute(attributeName);
  if (!rawValue) {
    return;
  }

  if (!rawValue.trim()) {
    element.removeAttribute(attributeName);
    return;
  }

  let canonical;
  let canonicalWithoutSearch;
  try {
    const resolved = new URL(rawValue, document.baseURI);
    resolved.hash = '';
    canonical = resolved.href;
    const withoutSearch = new URL(resolved.href);
    withoutSearch.search = '';
    canonicalWithoutSearch = withoutSearch.href;
  } catch (err) {
    return;
  }

  if (SELF_URL_BLOCKLIST.has(canonical) ||
      (canonicalWithoutSearch && SELF_URL_BLOCKLIST.has(canonicalWithoutSearch))) {
    console.error('[resource-guard] Blocked self-referential resource URL', {
      tag: element.tagName,
      attribute: attributeName,
      value: rawValue,
      canonical,
    });
    element.removeAttribute(attributeName);
  }
}

function sanitizeResourceTree(root) {
  if (!root) {
    return;
  }

  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    Array.from(root.childNodes).forEach((child) => sanitizeResourceTree(child));
    return;
  }

  if (root.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  sanitizeResourceAttribute(root, 'src');
  sanitizeResourceAttribute(root, 'href');
  sanitizeResourceAttribute(root, 'data');

  const nodes = root.querySelectorAll ? root.querySelectorAll(RESOURCE_QUERY) : [];
  nodes.forEach((node) => {
    sanitizeResourceAttribute(node, 'src');
    sanitizeResourceAttribute(node, 'href');
    sanitizeResourceAttribute(node, 'data');
  });
}

sanitizeResourceTree(document.documentElement);

const resourceObserver = new MutationObserver((records) => {
  records.forEach((record) => {
    if (record.type === 'attributes' && record.attributeName) {
      sanitizeResourceAttribute(record.target, record.attributeName);
      return;
    }

    if (record.type === 'childList') {
      record.addedNodes.forEach((node) => {
        sanitizeResourceTree(node);
      });
    }
  });
});

resourceObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['src', 'href', 'data'],
});

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
  phraseIndex: 0,
  autoScroll: false,
  statusHint: '',
  connectionStage: 'disconnected',
  readyByUser: false,
  activeSeq: 0,
};

const FONT_SCALES = [1, 26 / 28, 24 / 28, 22 / 28];

const TTS_RESULT_TIMEOUT_MS = 500;
const SILENCE_FALLBACK_DELAY_MS = 120;
const AUDIO_SYNC_WAIT_MS = 500;
const PREFETCH_LOOKAHEAD = 1;

let elements = {};
let statusFrameToken = null;
let userReadyResolvers = [];
const pendingTtsRequests = new Map();
const sentenceAudioCache = new Map();
let flowController = null;
let readyNotified = false;
let playbackQueueTail = Promise.resolve();

const CONNECTION_LABELS = {
  disconnected: '未接続',
  connected: '接続済み',
  ready: '準備OK',
};

function updateConnectionBadge() {
  if (!elements.connection) return;
  const stage = state.connectionStage;
  elements.connection.dataset.stage = stage;
  elements.connection.textContent = CONNECTION_LABELS[stage] || stage;
}

function setConnectionStage(stage) {
  state.connectionStage = stage;
  updateConnectionBadge();
}

function waitForUserReady() {
  if (state.readyByUser) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    userReadyResolvers.push(resolve);
  });
}

function markUserReady() {
  if (state.readyByUser) {
    return;
  }
  state.readyByUser = true;
  audioManager.resumeContext();
  console.info('user_ready=true', { timestamp: Date.now() });
  const resolvers = userReadyResolvers.splice(0);
  resolvers.forEach((resolve) => {
    try {
      resolve();
    } catch (err) {
      console.error('user-ready resolver failed', err);
    }
  });
  sendEvent('PRESENTER_READY', { at: Date.now() }, { seq: state.activeSeq });
}

function setupUserReadyListeners() {
  const handler = () => {
    markUserReady();
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
  window.addEventListener('pointerdown', handler, { once: true });
  window.addEventListener('keydown', handler, { once: true });
}

function cancelFlowController(reason = 'cancelled') {
  if (flowController) {
    const { controller, seq } = flowController;
    console.info(`CANCEL page_seq=${seq}`, { reason });
    if (controller && !controller.signal.aborted) {
      try {
        controller.abort();
      } catch (err) {
        console.error('flow abort failed', err);
      }
    }
  }
  flowController = null;
  typewriter.cancel(reason);
  audioManager.stopCurrent();
  playbackQueueTail = Promise.resolve();
}

function rejectPendingTts(reason) {
  const cause = reason || 'cancelled';
  if (!pendingTtsRequests.size) {
    clearSentenceAudioCache(cause);
    return;
  }
  pendingTtsRequests.forEach((entry, key) => {
    pendingTtsRequests.delete(key);
    const { seq, sentSeq } = entry;
    console.info(`DROP stale callback page_seq=${seq} sent_seq=${sentSeq}`, { reason: cause });
    try {
      entry.reject(new Error(cause));
    } catch (err) {
      console.error('reject tts failed', err);
    }
  });
  clearSentenceAudioCache(cause);
}

function sentenceCacheKey(seq, sentSeq) {
  return `${seq}:${sentSeq}`;
}

function clearSentenceAudioCache(reason = 'clear') {
  if (!sentenceAudioCache.size) {
    return;
  }
  console.info(`audio cache cleared reason=${reason}`);
  sentenceAudioCache.clear();
}

function ensureSentenceAudio(seq, sentSeq, options = {}) {
  const key = sentenceCacheKey(seq, sentSeq);
  const existing = sentenceAudioCache.get(key);
  const mode = options.mode || 'playback';
  if (existing) {
    if (mode === 'playback' && existing.mode === 'prefetch' && !existing.promoted) {
      existing.promoted = true;
      existing.mode = 'playback';
      console.info(`prefetch promote page_seq=${seq} sent_seq=${sentSeq}`);
    }
    return existing;
  }
  const requestId = createTtsRequestId(seq, state.pageIndex, sentSeq);
  const startedAt = performance.now();
  console.info(`${mode} request page_seq=${seq} sent_seq=${sentSeq}`);
  const entry = {
    requestId,
    seq,
    sentSeq,
    mode,
    promoted: mode !== 'prefetch',
    createdAt: startedAt,
  };
  entry.promise = requestSentenceAudio({ seq, sentSeq, requestId, mode })
    .then((chunks) => {
      const waitMs = Math.round(performance.now() - startedAt);
      console.info(`${mode} ready page_seq=${seq} sent_seq=${sentSeq}`, {
        wait_ms: waitMs,
        chunkCount: Array.isArray(chunks) ? chunks.length : 0,
      });
      return chunks;
    })
    .catch((err) => {
      sentenceAudioCache.delete(key);
      throw err;
    });
  sentenceAudioCache.set(key, entry);
  return entry;
}

function prefetchSentences(seq, page, startIndex = 0) {
  if (!Number.isFinite(seq) || seq <= 0) {
    return;
  }
  if (seq < state.activeSeq) {
    return;
  }
  if (!page || !Array.isArray(page.phrases) || page.phrases.length === 0) {
    return;
  }
  const limit = Math.min(page.phrases.length, startIndex + PREFETCH_LOOKAHEAD + 1);
  for (let idx = startIndex; idx < limit; idx += 1) {
    const phrase = page.phrases[idx];
    if (!phrase) {
      continue;
    }
    const length = phrase.length || (phrase.end - phrase.start);
    if (length <= 0) {
      continue;
    }
    const sentSeq = idx + 1;
    const key = sentenceCacheKey(seq, sentSeq);
    const existed = sentenceAudioCache.has(key);
    const entry = ensureSentenceAudio(seq, sentSeq, { mode: 'prefetch' });
    if (!existed) {
      console.info(`prefetch queued page_seq=${seq} sent_seq=${sentSeq}`, {
        preview: sentencePreview(page, phrase),
      });
    } else if (entry.mode === 'prefetch') {
      console.debug(`prefetch reuse page_seq=${seq} sent_seq=${sentSeq}`);
    }
  }
}

function activateSequence(seq) {
  if (typeof seq !== 'number' || Number.isNaN(seq)) {
    return state.activeSeq;
  }
  if (seq < state.activeSeq) {
    return state.activeSeq;
  }
  if (seq > state.activeSeq) {
    console.info(`active_page_seq set -> ${seq}`);
    state.activeSeq = seq;
    cancelFlowController('sequence-changed');
    rejectPendingTts('sequence-changed');
    audioManager.flush();
    state.typedLength = 0;
    state.phraseIndex = 0;
    scheduleStatus();
  }
  return state.activeSeq;
}

function ensureSequence(data = {}, seqFromMessage) {
  let seq = Number.isFinite(seqFromMessage) ? seqFromMessage : undefined;
  if (typeof seq === 'undefined' && data && typeof data.seq !== 'undefined') {
    const parsed = Number.parseInt(data.seq, 10);
    if (!Number.isNaN(parsed)) {
      seq = parsed;
    }
  }
  if (typeof seq === 'undefined') {
    return true;
  }
  if (seq < state.activeSeq) {
    console.info(`DROP stale command page_seq=${seq}`, { active: state.activeSeq });
    return false;
  }
  activateSequence(seq);
  return true;
}

function createFlowController(seq) {
  cancelFlowController('replaced');
  const controller = new AbortController();
  flowController = { controller, seq };
  return flowController;
}

function currentFlowController() {
  return flowController;
}

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
  let manualClose = false;
  let reconnectTimer = null;

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
    if (manualClose) {
      return;
    }
    if (socket) {
      try {
        socket.close();
      } catch (err) {
        // ignore close errors
      }
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
      if (manualClose) {
        return;
      }
      console.log('WS connect:', url);
      socket = new WebSocket(url);
      socket.onopen = () => {
        const pending = queue.splice(0);
        pending.forEach((msg) => socket.send(msg));
        console.info(`bridge socket open url=${url}`);
        setConnectionStage('connected');
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
      socket.onclose = (event) => {
        const reason = event.reason || '(no reason)';
        console.warn(`bridge socket closed url=${url} code=${event.code} reason=${reason}`);
        ready = false;
        readyNotified = false;
        setConnectionStage('disconnected');
        if (!manualClose) {
          connect(500);
        }
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
    close() {
      manualClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      listeners.clear();
      openListeners.clear();
      if (socket) {
        try {
          socket.close();
        } catch (err) {
          // ignore
        }
        socket = null;
      }
    },
  };
}

function createHttpBridge(baseUrl) {
  const listeners = new Set();
  const openListeners = new Set();
  let source = null;
  let manualClose = false;
  let reconnectTimer = null;

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
    if (manualClose) {
      return;
    }
    if (source) {
      try {
        source.close();
      } catch (err) {
        // ignore
      }
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
      if (manualClose) {
        return;
      }
      source = new EventSource(`${baseUrl}/api/presentation/events`, { withCredentials: false });
      source.onopen = () => {
        setConnectionStage('connected');
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
        readyNotified = false;
        setConnectionStage('disconnected');
        if (!manualClose) {
          connect(1000);
        }
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
    close() {
      manualClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      listeners.clear();
      openListeners.clear();
      if (source) {
        try {
          source.close();
        } catch (err) {
          // ignore
        }
        source = null;
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
      setConnectionStage('connected');
      notifyBridgeConnected();
    });
  }
  return bridgeConnection;
}

function closeBridgeConnection() {
  if (bridgeConnection && typeof bridgeConnection.close === 'function') {
    try {
      bridgeConnection.close();
    } catch (err) {
      console.error('bridge close failed', err);
    }
  }
  bridgeConnection = null;
  bridgeReceiver = null;
  pendingBridgeMessages = [];
  readyNotified = false;
  setConnectionStage('disconnected');
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

function sendEvent(type, payload = {}, options = {}) {
  const bridge = ensureBridge();
  const message = { type };
  const body = payload && typeof payload === 'object' ? { ...payload } : {};
  let seqValue;
  if (Object.prototype.hasOwnProperty.call(options, 'seq')) {
    seqValue = options.seq;
  } else if (options.includeSeq !== false) {
    seqValue = state.activeSeq;
  }
  if (typeof seqValue === 'number' && Number.isFinite(seqValue)) {
    message.seq = seqValue;
  }
  message.payload = body;
  bridge.send(message);
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

const HARD_SENTENCE_DELIMS = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
const WEAK_SENTENCE_DELIMS = new Set(['、', '，', ',', '・', '･', ';', '；', ':', '：', '…', '‥']);
const BRACKET_PAIRS = new Map([
  ['(', ')'],
  ['（', '）'],
  ['「', '」'],
  ['『', '』'],
  ['[', ']'],
  ['［', '］'],
  ['｛', '｝'],
  ['{', '}'],
  ['〈', '〉'],
  ['《', '》'],
  ['【', '】'],
  ['〔', '〕'],
]);

const SECONDARY_TRIGGER = 140;
const SECONDARY_MAX = 160;
const SECONDARY_MIN = 40;

function computeBracketDepths(text) {
  const depth = new Array(text.length).fill(0);
  const closers = new Map();
  BRACKET_PAIRS.forEach((close, open) => {
    closers.set(close, open);
  });
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (closers.has(char)) {
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx] !== char) {
        stack.pop();
        idx -= 1;
      }
      if (idx >= 0) {
        stack.splice(idx, 1);
      }
    }
    depth[i] = stack.length;
    if (BRACKET_PAIRS.has(char)) {
      stack.push(BRACKET_PAIRS.get(char));
    }
  }
  return depth;
}

function splitPrimarySentences(text) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!HARD_SENTENCE_DELIMS.has(char)) {
      continue;
    }
    const end = i + 1;
    if (end > start) {
      segments.push({ start, end });
    }
    start = end;
    while (start < text.length && text[start] === '\n') {
      start += 1;
    }
    if (start > i + 1) {
      i = start - 1;
    }
  }
  if (start < text.length) {
    segments.push({ start, end: text.length });
  }
  return segments;
}

function splitLongSentence(text, start, end, depths) {
  const parts = [];
  let cursor = start;
  while (cursor < end) {
    const remaining = end - cursor;
    if (remaining <= SECONDARY_MAX) {
      parts.push({ start: cursor, end });
      break;
    }
    const searchEnd = Math.min(end, cursor + SECONDARY_MAX);
    const searchStart = Math.min(end, cursor + SECONDARY_TRIGGER);
    let cut = -1;
    for (let idx = searchEnd - 1; idx >= searchStart; idx -= 1) {
      if (depths[idx] !== 0) {
        continue;
      }
      if (!WEAK_SENTENCE_DELIMS.has(text[idx])) {
        continue;
      }
      if (idx + 1 - cursor < SECONDARY_MIN) {
        continue;
      }
      cut = idx + 1;
      break;
    }
    if (cut === -1) {
      for (let idx = searchEnd - 1; idx > cursor + SECONDARY_MIN; idx -= 1) {
        if (depths[idx] !== 0) {
          continue;
        }
        if (/\s/.test(text[idx])) {
          cut = idx + 1;
          break;
        }
      }
    }
    if (cut === -1 || cut <= cursor) {
      cut = Math.min(end, cursor + SECONDARY_MAX);
    }
    parts.push({ start: cursor, end: cut });
    cursor = cut;
  }
  return parts;
}

function computePhrases(text) {
  if (!text) {
    return [{ start: 0, end: 0, length: 0 }];
  }
  const depths = computeBracketDepths(text);
  const primary = splitPrimarySentences(text);
  const phrases = [];
  primary.forEach((segment) => {
    let { start, end } = segment;
    while (start < end && /[\s\t\r]/.test(text[start])) {
      start += 1;
    }
    while (end > start && /[\s\t\r]/.test(text[end - 1])) {
      end -= 1;
    }
    if (end <= start) {
      return;
    }
    const length = end - start;
    if (length > SECONDARY_TRIGGER) {
      const splits = splitLongSentence(text, start, end, depths);
      splits.forEach((piece) => {
        if (piece.end > piece.start) {
          phrases.push({ start: piece.start, end: piece.end, length: piece.end - piece.start });
        }
      });
    } else {
      phrases.push({ start, end, length });
    }
  });
  if (!phrases.length) {
    phrases.push({ start: 0, end: text.length, length: text.length });
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFlowActive(flow) {
  if (!flow || !flow.controller) {
    return false;
  }
  return !flow.controller.signal.aborted && flow.seq === state.activeSeq;
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

function resetPlaybackState(options = {}) {
  const { flushAudio = false, resetIndex = true, preserveAudioCache = false } = options;
  cancelFlowController('reset');
  if (flushAudio) {
    audioManager.flush();
  }
  if (!preserveAudioCache) {
    rejectPendingTts('reset');
  }
  if (resetIndex) {
    state.phraseIndex = 0;
  }
  scheduleStatus();
}

function registerTtsPromise(requestId, seq, sentSeq, resolve, reject) {
  pendingTtsRequests.set(requestId, { resolve, reject, seq, sentSeq });
}

function settleTtsPromise(requestId, callback) {
  const entry = pendingTtsRequests.get(requestId);
  if (!entry) {
    return;
  }
  pendingTtsRequests.delete(requestId);
  try {
    callback(entry);
  } catch (err) {
    console.error('tts callback failed', err);
  }
}

function requestSentenceAudio({ seq, sentSeq, requestId, mode }) {
  return new Promise((resolve, reject) => {
    registerTtsPromise(requestId, seq, sentSeq, resolve, reject);
    sendEvent('TTS_REQUEST', {
      seq,
      sentSeq,
      requestId,
      mode,
    }, { seq });
  });
}

function computeSentenceStart(page, phrase) {
  if (!page || !phrase) {
    return 0;
  }
  return Math.max(0, Math.min(phrase.start, page.graphemes.length));
}

function computeSentenceEnd(page, phrase) {
  if (!page || !phrase) {
    return 0;
  }
  return Math.max(0, Math.min(phrase.end, page.graphemes.length));
}

function sentencePreview(page, phrase) {
  if (!page || !phrase) {
    return '';
  }
  const slice = page.graphemes.slice(phrase.start, phrase.end).join('');
  return slice.slice(0, 20);
}

function createPlaybackQueue(flow) {
  let queueCount = 0;
  let tail = Promise.resolve();
  playbackQueueTail = tail;

  const update = () => {
    audioManager.setQueueCount(queueCount);
  };

  const enqueue = (task) => {
    queueCount += 1;
    update();
    tail = tail
      .then(async () => {
        queueCount = Math.max(0, queueCount - 1);
        update();
        if (!isFlowActive(flow)) {
          return;
        }
        await task();
      })
      .catch((err) => {
        console.error('audio queue step failed', err);
      });
    playbackQueueTail = tail;
    return tail;
  };

  const drain = () => tail;

  return { enqueue, drain };
}

function createTtsRequestId(seq, pageIndex, sentSeq) {
  return `${seq}:${pageIndex}:${sentSeq}:${Date.now()}`;
}

async function resolveTtsWithTimeout(ttsPromise, { seq, sentSeq }) {
  const started = performance.now();
  try {
    const outcome = await Promise.race([
      Promise.resolve(ttsPromise).then((chunks) => ({ type: 'chunks', chunks })),
      delay(TTS_RESULT_TIMEOUT_MS).then(() => ({ type: 'timeout' })),
    ]);
    if (!outcome || outcome.type === 'timeout') {
      console.info(`tts wait timeout page_seq=${seq} sent_seq=${sentSeq}`, {
        wait_ms: Math.round(performance.now() - started),
      });
      Promise.resolve(ttsPromise)
        .then((chunks) => {
          if (Array.isArray(chunks) && chunks.length) {
            console.info(`DROP stale callback page_seq=${seq} sent_seq=${sentSeq}`, { reason: 'late_tts' });
          }
        })
        .catch((err) => {
          console.info(`DROP stale callback page_seq=${seq} sent_seq=${sentSeq}`, {
            reason: 'late_tts_error',
            error: err && err.message ? err.message : String(err),
          });
        });
      return { chunks: [], timeout: true };
    }
    const elapsed = Math.round(performance.now() - started);
    const chunks = Array.isArray(outcome.chunks) ? outcome.chunks : [];
    console.info(`tts ready page_seq=${seq} sent_seq=${sentSeq}`, { wait_ms: elapsed });
    return { chunks, timeout: false };
  } catch (err) {
    console.error('tts wait failed', err);
    console.info(`DROP stale callback page_seq=${seq} sent_seq=${sentSeq}`, { reason: 'error' });
    return { chunks: [], timeout: false };
  }
}

async function processSentence(flow, page, sentenceIndex, playbackQueue) {
  const phrase = page.phrases[sentenceIndex];
  if (!phrase) {
    state.phraseIndex = sentenceIndex + 1;
    scheduleStatus();
    return true;
  }
  if (!isFlowActive(flow)) {
    return false;
  }
  const seq = flow.seq;
  const sentSeq = sentenceIndex + 1;
  console.info(`enqueue sentence sent_seq=${sentSeq}`, {
    page_seq: seq,
    text: sentencePreview(page, phrase),
  });
  const sentenceStart = computeSentenceStart(page, phrase);
  const sentenceEnd = computeSentenceEnd(page, phrase);
  const absoluteStart = page.start + sentenceStart;
  const absoluteEnd = page.start + sentenceEnd;
  const cacheKey = sentenceCacheKey(seq, sentSeq);
  const entry = ensureSentenceAudio(seq, sentSeq, { mode: 'playback' });
  const ttsPromise = entry.promise.catch((err) => {
    const reason = err && err.message ? err.message : '';
    if (!['cancelled', 'sequence-changed', 'stopped', 'reset'].includes(reason)) {
      console.error('tts request failed', err);
    }
    throw err;
  });
  if (state.typedLength > sentenceStart) {
    state.typedLength = sentenceStart;
    setDisplayedText(page, state.typedLength);
  }
  if (state.typedLength < sentenceStart) {
    state.typedLength = sentenceStart;
    setDisplayedText(page, state.typedLength);
  }
  updateScroll(page);
  console.info(`display start page_seq=${seq} sent_seq=${sentSeq}`, {
    start: absoluteStart,
    end: absoluteEnd,
  });
  let readyChunks = null;
  let audioReady = false;
  try {
    const syncResult = await Promise.race([
      Promise.resolve(ttsPromise).then((chunks) => ({ type: 'ready', chunks })),
      delay(AUDIO_SYNC_WAIT_MS).then(() => ({ type: 'timeout' })),
    ]);
    if (syncResult && syncResult.type === 'ready') {
      readyChunks = Array.isArray(syncResult.chunks) ? syncResult.chunks : [];
      audioReady = true;
    }
  } catch (err) {
    console.error('audio sync wait failed', err);
  }
  const typePromise = typewriter.revealTo(page, sentenceEnd, flow);
  playbackQueue.enqueue(async () => {
    if (!isFlowActive(flow)) {
      return;
    }
    let chunks = readyChunks;
    let timeout = false;
    if (!chunks) {
      const resolved = await resolveTtsWithTimeout(ttsPromise, { seq, sentSeq });
      chunks = resolved.chunks;
      timeout = resolved.timeout;
    } else {
      console.info(`tts cached page_seq=${seq} sent_seq=${sentSeq}`, {
        wait_ms: Math.round(performance.now() - (entry.createdAt || performance.now())),
      });
    }
    if (!isFlowActive(flow)) {
      return;
    }
    if (Array.isArray(chunks) && chunks.length) {
      const started = performance.now();
      console.info(`play start page_seq=${seq} sent_seq=${sentSeq}`);
      try {
        await audioManager.playChunks(chunks, { controller: flow.controller, seq, sentSeq });
      } finally {
        const elapsed = Math.round(performance.now() - started);
        console.info(`play end page_seq=${seq} sent_seq=${sentSeq}`, { dur_ms: elapsed });
      }
    } else if (timeout || !audioReady) {
      const reason = timeout ? 'timeout' : 'no_audio';
      console.info(`play skip page_seq=${seq} sent_seq=${sentSeq}`, { reason });
      if (timeout && SILENCE_FALLBACK_DELAY_MS > 0) {
        await delay(SILENCE_FALLBACK_DELAY_MS);
      }
    } else {
      console.info(`play skip page_seq=${seq} sent_seq=${sentSeq}`, { reason: 'no_audio' });
    }
    if (!isFlowActive(flow)) {
      return;
    }
    state.phraseIndex = sentenceIndex + 1;
    scheduleStatus();
    sentenceAudioCache.delete(cacheKey);
  });
  try {
    await typePromise;
    console.info(`display end page_seq=${seq} sent_seq=${sentSeq}`);
  } catch (err) {
    return false;
  }
  state.typedLength = Math.max(state.typedLength, sentenceEnd);
  setDisplayedText(page, state.typedLength);
  updateScroll(page);
  if (!isFlowActive(flow)) {
    return false;
  }
  prefetchSentences(seq, page, sentenceIndex + 1);
  return true;
}

async function runPresentationFlow(startSentence = 0) {
  const page = currentPage();
  if (!page || !page.phrases) {
    return;
  }
  const seq = state.activeSeq;
  const flow = createFlowController(seq);
  if (!flow) {
    return;
  }
  const { controller } = flow;
  if (!controller) {
    return;
  }
  state.phraseIndex = Math.max(0, Math.min(startSentence, page.phrases.length));
  const playbackQueue = createPlaybackQueue(flow);
  prefetchSentences(seq, page, state.phraseIndex);
  for (let index = startSentence; index < page.phrases.length; index += 1) {
    if (!isFlowActive(flow)) {
      return;
    }
    const ok = await processSentence(flow, page, index, playbackQueue);
    if (!ok) {
      return;
    }
  }
  await playbackQueue.drain();
  if (isFlowActive(flow)) {
    setStatusHint('完了');
    scheduleStatus();
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
  sendEvent('STATUS', payload);
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
  currentSource: null,
  playbackSeq: 0,
  queueCount: 0,
  chunkCount: 0,

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
    if (ctx && ctx.state === 'suspended' && state.readyByUser) {
      ctx.resume().catch(() => {});
    }
    return ctx;
  },

  resumeContext() {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  },

  async decode(base64) {
    const ctx = this.ensureContext();
    if (!ctx) {
      return null;
    }
    try {
      return await ctx.decodeAudioData(base64ToArrayBuffer(base64));
    } catch (err) {
      reportError('audio_decode_failed', err);
      return null;
    }
  },

  async playChunks(chunks, meta) {
    if (!Array.isArray(chunks) || !chunks.length) {
      return;
    }
    const { controller, seq, sentSeq } = meta;
    if (!controller || controller.signal.aborted) {
      return;
    }
    this.playbackSeq = seq;
    this.chunkCount = chunks.length;
    scheduleStatus();
    for (let index = 0; index < chunks.length; index += 1) {
      const item = chunks[index];
      if (controller.signal.aborted || seq !== state.activeSeq) {
        break;
      }
      const base64 = typeof item === 'string' ? item : item && item.wavBase64;
      if (!base64) {
        this.chunkCount = Math.max(0, this.chunkCount - 1);
        scheduleStatus();
        continue;
      }
      const buffer = await this.decode(base64);
      if (!buffer) {
        this.chunkCount = Math.max(0, this.chunkCount - 1);
        scheduleStatus();
        continue;
      }
      if (controller.signal.aborted || seq !== state.activeSeq) {
        break;
      }
      if (typeof sentSeq === 'number') {
        console.info(`tts play chunk start page_seq=${seq} sent_seq=${sentSeq}`, {
          chunk: index + 1,
          total: chunks.length,
        });
      }
      try {
        await this.playBuffer(buffer, meta);
      } catch (err) {
        reportError('audio_start_failed', err);
        break;
      } finally {
        this.chunkCount = Math.max(0, this.chunkCount - 1);
        scheduleStatus();
      }
    }
    this.playbackSeq = 0;
    this.chunkCount = Math.max(0, this.chunkCount);
    scheduleStatus();
  },

  playBuffer(buffer, meta) {
    return new Promise((resolve) => {
      const ctx = this.ensureContext();
      if (!ctx) {
        resolve();
        return;
      }
      if (meta.controller.signal.aborted || meta.seq !== state.activeSeq) {
        resolve();
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const cleanup = () => {
        if (this.currentSource === source) {
          this.currentSource = null;
        }
        source.onended = null;
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        resolve();
      };
      source.onended = cleanup;
      const abortHandler = () => {
        try {
          source.stop();
        } catch (err) {
          console.debug('audio stop error', err);
        }
        cleanup();
      };
      const signal = meta.controller.signal;
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      this.currentSource = source;
      try {
        source.start();
      } catch (err) {
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        this.currentSource = null;
        throw err;
      }
    });
  },

  stopCurrent() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (err) {
        console.debug('audio stop failed', err);
      }
      try {
        this.currentSource.disconnect();
      } catch (err) {
        console.debug('audio disconnect failed', err);
      }
      this.currentSource = null;
    }
    this.playbackSeq = 0;
    this.chunkCount = 0;
    this.queueCount = 0;
    scheduleStatus();
  },

  flush() {
    this.stopCurrent();
  },

  setQueueCount(count) {
    this.queueCount = Math.max(0, count);
    scheduleStatus();
  },

  queueLength() {
    return (this.currentSource ? 1 : 0) + this.queueCount + this.chunkCount;
  },
};

const typewriter = {
  rafId: null,
  running: false,
  lastTimestamp: 0,
  completion: null,
  targetLength: 0,
  controller: null,

  async revealTo(page, targetLength, flow) {
    this.cancel('replaced');
    const limit = Math.max(0, Math.min(targetLength, page.graphemes.length));
    if (state.typedLength > limit) {
      state.typedLength = limit;
      setDisplayedText(page, state.typedLength);
      updateScroll(page);
    }
    if (state.typedLength === limit) {
      return;
    }
    this.running = true;
    this.lastTimestamp = performance.now();
    this.targetLength = limit;
    this.controller = flow;
    const signal = flow && flow.controller ? flow.controller.signal : null;
    const seq = flow && typeof flow.seq === 'number' ? flow.seq : state.activeSeq;
    return new Promise((resolve, reject) => {
      this.completion = { resolve, reject };
      const step = (timestamp) => {
        if (!this.running) {
          return;
        }
        if ((signal && signal.aborted) || seq !== state.activeSeq) {
          this.cancel('aborted');
          return;
        }
        if (state.typedLength >= this.targetLength) {
          this.finish();
          return;
        }
        if (!this.lastTimestamp) {
          this.lastTimestamp = timestamp;
        }
        const delay = computeDelay(page, state.typedLength);
        if (timestamp - this.lastTimestamp >= delay) {
          state.typedLength += 1;
          setDisplayedText(page, state.typedLength);
          updateScroll(page);
          scheduleStatus();
          this.lastTimestamp = timestamp;
        }
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    });
  },

  finish() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.running = false;
    const completion = this.completion;
    this.completion = null;
    if (completion) {
      try {
        completion.resolve();
      } catch (err) {
        console.error('typewriter resolve failed', err);
      }
    }
    scheduleStatus();
  },

  cancel(reason = 'cancelled') {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    const completion = this.completion;
    this.completion = null;
    this.running = false;
    if (completion) {
      try {
        completion.reject(new Error(reason));
      } catch (err) {
        console.error('typewriter reject failed', err);
      }
    }
  },

  stop(withFlash = false) {
    this.cancel('stopped');
    if (withFlash) {
      flashOverlay();
    }
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
  resetPlaybackState({
    flushAudio: options.flushAudio !== false,
    preserveAudioCache: Boolean(options.preserveAudioCache),
  });
  if (elements.content) {
    elements.content.textContent = '';
  }
  if (elements.contentShell) {
    elements.contentShell.scrollTop = 0;
  }
  updatePageIndicator();
  await fitContent(page);
  if (page) {
    setDisplayedText(page, state.typedLength);
  }
  scheduleStatus();
}

function reportError(code, error) {
  console.error(code, error);
  const message = error && error.message ? error.message : String(error);
  sendEvent('ERROR', { code, message });
}

const handlers = {
  PAGE_SEQ(_data = {}, seq) {
    if (!Number.isFinite(seq)) {
      return;
    }
    const target = Number(seq);
    console.info(`rx PAGE_SEQ seq=${target}`);
    activateSequence(target);
    sendEvent('PRESENTER_ACK', { ack: 'PAGE_SEQ' }, { seq: target });
    setStatusHint('待機中');
    scheduleStatus();
  },

  PRESENTATION_INIT() {
    setConnectionStage('ready');
    if (!state.question) {
      setStatusHint('待機中');
      scheduleStatus();
    }
  },

  async PRESENT(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    const pageSeq = Number.isFinite(seq) ? seq : state.activeSeq;
    console.info(`rx PRESENT page_seq=${pageSeq}`);
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
    const page = currentPage();
    const phrases = page && Array.isArray(page.phrases) ? page.phrases : [];
    const sentences = phrases.map((phrase, idx) => ({
      start: page.start + computeSentenceStart(page, phrase),
      end: page.start + computeSentenceEnd(page, phrase),
      length: phrase.length || (phrase.end - phrase.start),
      sentSeq: idx + 1,
    }));
    const lengths = sentences.map((item) => item.length);
    const samples = phrases.map((phrase) => sentencePreview(page, phrase)).slice(0, 5);
    console.info(`split result page_seq=${pageSeq}`, { count: sentences.length, lengths });
    console.info(`tx SENTENCES_READY page_seq=${pageSeq}`, { count: sentences.length });
    sendEvent('SENTENCES_READY', { count: sentences.length, samples, sentences, lengths }, { seq: pageSeq });
    prefetchSentences(pageSeq, page, 0);
  },

  async START(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    const active = state.activeSeq;
    console.info(`rx START page_seq=${active}`);
    const fromPage = Number.isInteger(data.fromPage) ? data.fromPage : state.pageIndex;
    const needsReset = fromPage !== state.pageIndex;
    await setPage(fromPage, {
      flushAudio: needsReset,
      preserveAudioCache: !needsReset,
    });
    prefetchSentences(state.activeSeq, currentPage(), 0);
    await waitForUserReady();
    if (active !== state.activeSeq) {
      return;
    }
    const page = currentPage();
    if (!page) {
      return;
    }
    prefetchSentences(state.activeSeq, page, 0);
    state.phraseIndex = 0;
    state.typedLength = 0;
    setDisplayedText(page, 0);
    updateScroll(page);
    setStatusHint('進行中');
    await runPresentationFlow(0);
  },

  STOP_ALL(_data = {}, seq) {
    if (!ensureSequence({}, seq)) {
      return;
    }
    cancelFlowController('stopped');
    audioManager.flush();
    rejectPendingTts('stopped');
    typewriter.stop(true);
    setStatusHint('停止中');
    scheduleStatus();
  },

  async RESUME(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    console.info(`rx resume page_seq=${state.activeSeq}`);
    const expectedSeq = state.activeSeq;
    console.info(`rx RESUME page_seq=${expectedSeq}`);
    await waitForUserReady();
    if (expectedSeq !== state.activeSeq) {
      return;
    }
    const page = currentPage();
    if (!page) {
      return;
    }
    const index = Math.max(0, Math.min(state.phraseIndex, page.phrases.length));
    const phrase = page.phrases[index];
    const startLength = phrase ? computeSentenceStart(page, phrase) : page.graphemes.length;
    state.typedLength = Math.max(state.typedLength, startLength);
    setDisplayedText(page, state.typedLength);
    updateScroll(page);
    setStatusHint('再開');
    await runPresentationFlow(index);
  },

  async GOTO_PAGE(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    const index = Number.isInteger(data.page) ? data.page : 0;
    await setPage(index, { flushAudio: true });
    setStatusHint(`ページ ${state.pageIndex + 1}`);
    const page = currentPage();
    const phrases = page && Array.isArray(page.phrases) ? page.phrases : [];
    const sentences = phrases.map((phrase, idx) => ({
      start: page.start + computeSentenceStart(page, phrase),
      end: page.start + computeSentenceEnd(page, phrase),
      length: phrase.length || (phrase.end - phrase.start),
      sentSeq: idx + 1,
    }));
    const lengths = sentences.map((item) => item.length);
    const samples = phrases.map((phrase) => sentencePreview(page, phrase)).slice(0, 5);
    console.info(`split result page_seq=${state.activeSeq}`, { count: sentences.length, lengths });
    console.info(`tx SENTENCES_READY page_seq=${state.activeSeq}`, { count: sentences.length });
    sendEvent('SENTENCES_READY', { count: sentences.length, samples, sentences, lengths }, { seq: state.activeSeq });
    prefetchSentences(state.activeSeq, page, 0);
  },

  SET_CPS(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    if (typeof data.value === 'number') {
      state.cps = data.value;
      updateSettingsHint();
      scheduleStatus();
    }
  },

  SET_PAUSE_FACTOR(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    if (typeof data.value === 'number') {
      state.pauseFactor = data.value;
      updateSettingsHint();
      scheduleStatus();
    }
  },

  SET_ZOOM(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    if (typeof data.value === 'number') {
      applyZoom(data.value);
    }
  },

  SET_COMPACT(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    setCompact(Boolean(data.value));
  },

  REVEAL(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    console.info(`rx REVEAL page_seq=${state.activeSeq}`);
    document.body.classList.add('show-answer');
  },

  CLEAR(data = {}, seq) {
    if (!ensureSequence(data, seq)) {
      return;
    }
    clearAnswerPanel();
  },

  TTS_RESULT(data = {}, seq) {
    const ok = ensureSequence(data, seq);
    const requestId = data && data.requestId;
    if (!requestId) {
      return;
    }
    const resultSeq = Number.isInteger(seq) ? seq : Number.parseInt(seq, 10);
    const resultSentSeq = Number.isInteger(data.sentSeq) ? data.sentSeq : Number.parseInt(data.sentSeq, 10);
    settleTtsPromise(requestId, ({ resolve, reject, seq: expectedSeq, sentSeq: expectedSentSeq }) => {
      if (!ok) {
        console.info(`DROP stale callback page_seq=${resultSeq} sent_seq=${resultSentSeq}`, {
          reason: 'sequence_guard',
        });
        reject(new Error('stale'));
        return;
      }
      if (Number.isFinite(resultSeq) && typeof expectedSeq === 'number' && resultSeq !== expectedSeq) {
        console.info(`DROP stale callback page_seq=${resultSeq} sent_seq=${resultSentSeq}`, {
          reason: 'seq_mismatch',
          expected: expectedSeq,
        });
        reject(new Error('stale'));
        return;
      }
      if (Number.isFinite(resultSentSeq) && typeof expectedSentSeq === 'number' && resultSentSeq !== expectedSentSeq) {
        console.info(`DROP stale callback page_seq=${resultSeq} sent_seq=${resultSentSeq}`, {
          reason: 'sent_seq_mismatch',
          expected: expectedSentSeq,
        });
        reject(new Error('stale'));
        return;
      }
      resolve(Array.isArray(data.chunks) ? data.chunks : []);
    });
  },
};

window.appBridge = {
  receive(message) {
    try {
      const payload = typeof message === 'string' ? JSON.parse(message) : message;
      if (!payload) {
        return;
      }
      const type = payload.type || payload.action;
      if (!type) {
        return;
      }
      const handler = handlers[type];
      if (handler) {
        const seq = typeof payload.seq === 'number' ? payload.seq : Number.parseInt(payload.seq, 10);
        const body = payload.payload && typeof payload.payload === 'object' ? { ...payload.payload } : {};
        if (Number.isFinite(seq) && typeof body.seq === 'undefined') {
          body.seq = seq;
        }
        Promise.resolve(handler(body, seq, payload)).catch((err) => reportError('handler_failed', err));
      }
    } catch (err) {
      reportError('receive_failed', err);
    }
  },
};

setBridgeReceiver(window.appBridge.receive);
ensureBridge();
setupUserReadyListeners();

function notifyBridgeConnected() {
  if (readyNotified) return;
  readyNotified = true;
  sendEvent('PRESENTER_CONNECTED', {});
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
    connection: document.getElementById('connectionBadge'),
  };
  applyZoom(state.zoom);
  setCompact(state.compact);
  updateSettingsHint();
  updateConnectionBadge();
  scheduleStatus();
});

window.addEventListener('error', (event) => {
  reportError('runtime_error', event.error || event.message);
});

window.addEventListener('beforeunload', () => {
  closeBridgeConnection();
});
