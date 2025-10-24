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
  connectionStage: 'disconnected',
  readyByUser: false,
  presenterReadySent: false,
  activeSeq: 0,
  seqToken: null,
  question: null,
  pages: [],
  pageIndex: 0,
  sentenceIndex: 0,
  running: false,
  pendingStart: null,
  requestedSentences: new Set(),
  sentenceElements: [],
  statusHint: '',
  settings: {
    cps: 14,
    pauseFactor: 1.0,
    zoom: 1.1,
    compact: true,
  },
};

const params = new URLSearchParams(window.location.search || '');
const bridgeMode = (params.get('mode') || 'ws').toLowerCase();
const bridgePort = Number.parseInt(params.get('port') || '8765', 10);
const bridgeWsUrl = `ws://127.0.0.1:${bridgePort}/presentation`;
const bridgeHttpBase = `http://127.0.0.1:${bridgePort}`;

const audioStore = new Map();

function audioKey(seq, index) {
  return `${seq}:${index}`;
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

function computeSentences(fullText) {
  const sentences = [];
  let index = 0;
  const length = fullText.length;
  const closingChars = '」』〕］）】〙〗〟”’"»›》』』】）)';
  while (index < length) {
    let end = index;
    let encountered = false;
    while (end < length) {
      const char = fullText[end];
      if (char === '\n') {
        end += 1;
        encountered = true;
        break;
      }
      if ('。．.!?！？'.includes(char)) {
        end += 1;
        while (end < length && closingChars.includes(fullText[end])) {
          end += 1;
        }
        while (end < length && fullText[end] === '\n') {
          end += 1;
          break;
        }
        encountered = true;
        break;
      }
      end += 1;
    }
    if (!encountered) {
      end = length;
    }
    if (end === index) {
      end += 1;
    }
    const text = fullText.slice(index, end);
    if (text.trim().length > 0) {
      sentences.push({
        index: sentences.length,
        start: index,
        end,
        text,
        graphemes: segmentGraphemes(text),
      });
    }
    index = end;
  }
  if (!sentences.length) {
    sentences.push({ index: 0, start: 0, end: 0, text: '', graphemes: [] });
  }
  return sentences;
}

function paginate(fullText) {
  const sentences = computeSentences(fullText);
  const approxLine = 28;
  const maxLines = 10;
  const pages = [];
  let current = [];
  let linesUsed = 0;
  sentences.forEach((sentence) => {
    const sentenceLines = Math.max(1, estimateLines(sentence.text, approxLine));
    if (current.length && linesUsed + sentenceLines > maxLines) {
      pages.push(current);
      current = [];
      linesUsed = 0;
    }
    current.push(sentence);
    linesUsed += sentenceLines;
  });
  if (current.length) {
    pages.push(current);
  }
  if (!pages.length) {
    pages.push([]);
  }
  return pages.map((pageSentences, pageIndex) => {
    const mapped = pageSentences.map((sentence, idx) => ({
      index: idx,
      absoluteIndex: sentence.index,
      start: sentence.start,
      end: sentence.end,
      text: sentence.text,
      graphemes: sentence.graphemes,
    }));
    const start = pageSentences.length ? pageSentences[0].start : 0;
    const end = pageSentences.length ? pageSentences[pageSentences.length - 1].end : 0;
    return {
      index: pageIndex,
      sentences: mapped,
      start,
      end,
      text: pageSentences.map((entry) => entry.text).join(''),
    };
  });
}

function getCurrentPage() {
  return state.pages[state.pageIndex] || null;
}

const elements = {
  app: null,
  content: null,
  title: null,
  status: null,
  pageIndicator: null,
  connection: null,
  readyGate: null,
  interactionHint: null,
  answerOverlay: null,
  answers: null,
  explain: null,
  buildInfo: null,
};

function cacheElements() {
  elements.app = document.getElementById('app');
  elements.content = document.getElementById('content');
  elements.title = document.getElementById('questionTitle');
  elements.status = document.getElementById('statusHint');
  elements.pageIndicator = document.getElementById('pageIndicator');
  elements.connection = document.getElementById('connectionBadge');
  elements.readyGate = document.getElementById('readyGate');
  elements.interactionHint = document.getElementById('interactionHint');
  elements.answerOverlay = document.getElementById('answerOverlay');
  elements.answers = document.getElementById('answers');
  elements.explain = document.getElementById('explain');
  elements.buildInfo = document.getElementById('buildInfo');
}

const CONNECTION_LABELS = {
  disconnected: '未接続',
  connected: '接続済み',
  ready: '準備OK',
};

function updateConnectionBadge() {
  if (!elements.connection) return;
  elements.connection.dataset.stage = state.connectionStage;
  elements.connection.textContent = CONNECTION_LABELS[state.connectionStage] || state.connectionStage;
}

function setConnectionStage(stage) {
  state.connectionStage = stage;
  updateConnectionBadge();
}

function setStatusHint(message) {
  state.statusHint = message || '';
  updateStatusHint();
}

function updateStatusHint() {
  if (!elements.status) return;
  const base = `CPS ${state.settings.cps}｜ポーズ ${state.settings.pauseFactor.toFixed(2)}｜ズーム ${state.settings.zoom.toFixed(2)}`;
  elements.status.textContent = state.statusHint ? `${state.statusHint} ／ ${base}` : base;
}

function updatePageIndicator() {
  if (!elements.pageIndicator) return;
  const total = state.pages.length || 1;
  elements.pageIndicator.textContent = `${Math.min(state.pageIndex + 1, total)}/${total}`;
}

function showAnswerOverlay(payload) {
  if (!elements.answerOverlay) return;
  elements.answerOverlay.classList.add('active');
  if (elements.answers) {
    const answers = Array.isArray(payload?.answers) ? payload.answers : [];
    elements.answers.textContent = answers.join(' ／ ');
  }
  if (elements.explain) {
    elements.explain.textContent = payload?.explain || '';
  }
}

function hideAnswerOverlay() {
  if (!elements.answerOverlay) return;
  elements.answerOverlay.classList.remove('active');
  if (elements.answers) {
    elements.answers.textContent = '';
  }
  if (elements.explain) {
    elements.explain.textContent = '';
  }
}

function updateReadyOverlay() {
  if (!elements.readyGate) return;
  elements.readyGate.classList.toggle('hidden', state.readyByUser);
}

function updateInteractionHint(message) {
  if (!elements.interactionHint) return;
  elements.interactionHint.textContent = message;
}

function applySettings() {
  if (!elements.app) return;
  const zoom = Number.isFinite(state.settings.zoom) ? state.settings.zoom : 1.0;
  document.documentElement.style.setProperty('--zoom', zoom.toFixed(2));
  elements.app.dataset.zoom = zoom.toFixed(2);
  elements.app.classList.toggle('compact', !!state.settings.compact);
  updateStatusHint();
}

function clearContent() {
  if (elements.content) {
    elements.content.innerHTML = '';
  }
  state.sentenceElements = [];
}

function ensureSentenceElement(index) {
  while (state.sentenceElements.length <= index) {
    const element = document.createElement('p');
    element.className = 'sentence';
    elements.content?.appendChild(element);
    state.sentenceElements.push(element);
  }
  return state.sentenceElements[index];
}

function requestSentenceAudio(seq, sentence, index) {
  const key = audioKey(seq, index);
  if (state.requestedSentences.has(key)) {
    return;
  }
  state.requestedSentences.add(key);
  sendMessage({
    type: 'tts_request',
    seq,
    sentence: {
      index,
      start: sentence.start,
      end: sentence.end,
    },
  });
}

function requestAhead(seq, startIndex) {
  const page = getCurrentPage();
  if (!page) return;
  for (let offset = 0; offset <= 2; offset += 1) {
    const target = startIndex + offset;
    if (target >= page.sentences.length) {
      break;
    }
    requestSentenceAudio(seq, page.sentences[target], target);
  }
}

function storeSentenceAudio(seq, index, chunks) {
  const key = audioKey(seq, index);
  const existing = audioStore.get(key) || { chunks: null, buffers: null, waiters: [] };
  existing.chunks = Array.isArray(chunks) ? chunks.map((chunk) => ({
    id: chunk.id,
    audio: chunk.audio,
  })) : [];
  existing.buffers = null;
  if (existing.waiters && existing.waiters.length) {
    existing.waiters.forEach((resolve) => {
      try {
        resolve(existing.chunks);
      } catch (err) {
        console.error('audio waiter resolve failed', err);
      }
    });
    existing.waiters = [];
  }
  audioStore.set(key, existing);
}

function waitForSentenceAudio(seq, index) {
  const key = audioKey(seq, index);
  const entry = audioStore.get(key);
  if (entry && entry.chunks) {
    return Promise.resolve(entry.chunks);
  }
  return new Promise((resolve) => {
    const pending = audioStore.get(key);
    if (pending) {
      pending.waiters.push(resolve);
    } else {
      audioStore.set(key, { chunks: null, buffers: null, waiters: [resolve] });
    }
  });
}

function clearAudioStore() {
  audioStore.forEach((entry) => {
    if (entry.waiters) {
      entry.waiters.forEach((resolve) => {
        try {
          resolve(null);
        } catch (err) {
          console.error('audio waiter clear failed', err);
        }
      });
    }
  });
  audioStore.clear();
}

function decodeAudioBuffer(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    context.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
  });
}

async function getDecodedBuffers(seq, index, chunks) {
  const key = audioKey(seq, index);
  const entry = audioStore.get(key);
  if (!entry) {
    return [];
  }
  if (entry.buffers && entry.buffers.length === chunks.length) {
    return entry.buffers;
  }
  const context = audioManager.getContext();
  if (!context) {
    return [];
  }
  const buffers = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    try {
      const buffer = await decodeAudioBuffer(context, base64ToArrayBuffer(chunk.audio));
      buffers.push(buffer);
    } catch (err) {
      console.error('audio decode failed', err);
    }
  }
  entry.buffers = buffers;
  audioStore.set(key, entry);
  return buffers;
}

const audioManager = {
  context: null,
  currentSource: null,
  getContext() {
    if (this.context) {
      return this.context;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    this.context = new Ctor();
    return this.context;
  },
  async resume() {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('audio resume failed', err);
      }
    }
  },
  stop() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (err) {
        console.error('audio stop failed', err);
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
  },
  flush() {
    this.stop();
  },
  isPlaying() {
    return !!this.currentSource;
  },
  async playBuffers(seq, token, buffers) {
    if (!buffers || !buffers.length) {
      return;
    }
    const ctx = this.getContext();
    if (!ctx) {
      return;
    }
    await this.resume();
    for (const buffer of buffers) {
      if (!isSequenceActive(seq, token)) {
        this.stop();
        return;
      }
      await new Promise((resolve) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
          if (this.currentSource === source) {
            this.currentSource = null;
          }
          resolve();
        };
        try {
          source.start();
          this.currentSource = source;
        } catch (err) {
          console.error('audio start failed', err);
          resolve();
        }
      });
    }
  },
};

function isSequenceActive(seq, token) {
  return seq === state.activeSeq && token === state.seqToken;
}

function pendingAudioCount() {
  const page = getCurrentPage();
  if (!page) {
    return 0;
  }
  let ready = 0;
  page.sentences.forEach((_, index) => {
    const entry = audioStore.get(audioKey(state.activeSeq, index));
    if (entry && entry.chunks && entry.chunks.length) {
      ready += 1;
    }
  });
  const playing = audioManager.isPlaying() ? 1 : 0;
  return Math.max(0, ready - state.sentenceIndex - playing);
}

function resetForSequence(seq) {
  state.activeSeq = seq;
  state.seqToken = {};
  state.running = false;
  state.pendingStart = null;
  state.sentenceIndex = 0;
  state.requestedSentences.clear();
  clearAudioStore();
  audioManager.flush();
  clearContent();
  hideAnswerOverlay();
  setStatusHint('待機中');
  sendStatus();
}

function handlePageSeq(message) {
  if (typeof message.seq !== 'number') {
    return;
  }
  resetForSequence(message.seq);
}

function handlePresent(message) {
  if (!isSequenceActive(message.seq || state.activeSeq, state.seqToken)) {
    resetForSequence(message.seq || state.activeSeq);
  }
  if (typeof message.seq === 'number' && message.seq !== state.activeSeq) {
    resetForSequence(message.seq);
  }
  if (!isSequenceActive(state.activeSeq, state.seqToken)) {
    resetForSequence(message.seq || state.activeSeq);
  }
  const payload = message.payload || {};
  state.question = payload;
  state.running = false;
  state.pendingStart = null;
  state.sentenceIndex = 0;
  state.requestedSentences.clear();
  clearAudioStore();
  audioManager.flush();
  hideAnswerOverlay();
  if (elements.title) {
    elements.title.textContent = payload.title || '';
  }
  const text = payload.body || payload.text || '';
  state.pages = paginate(text);
  const targetPage = Number.isInteger(payload.page) ? payload.page : 0;
  state.pageIndex = Math.max(0, Math.min(targetPage, state.pages.length - 1));
  updatePageIndicator();
  clearContent();
  const page = getCurrentPage();
  if (page && !page.sentences.length && text) {
    // If pagination collapsed to empty sentences, ensure at least one placeholder.
    page.sentences.push({ index: 0, absoluteIndex: 0, start: 0, end: text.length, text, graphemes: segmentGraphemes(text) });
  }
  setStatusHint('待機中');
  setConnectionStage('ready');
  sendStatus();
}

function handleSettings(message) {
  const payload = message.payload || {};
  if (typeof payload.cps === 'number') {
    state.settings.cps = payload.cps;
  }
  if (typeof payload.pauseFactor === 'number') {
    state.settings.pauseFactor = payload.pauseFactor;
  }
  if (typeof payload.zoom === 'number') {
    state.settings.zoom = payload.zoom;
  }
  if (typeof payload.compact === 'boolean') {
    state.settings.compact = payload.compact;
  }
  applySettings();
}

async function revealSentence(seq, token, sentence, element) {
  if (!element) {
    return;
  }
  element.classList.remove('sentence--complete');
  element.textContent = '';
  const graphemes = sentence.graphemes && sentence.graphemes.length ? sentence.graphemes : segmentGraphemes(sentence.text);
  if (!graphemes.length) {
    element.textContent = sentence.text;
    element.classList.add('sentence--complete');
    return;
  }
  for (let i = 0; i < graphemes.length; i += 1) {
    if (!isSequenceActive(seq, token)) {
      return;
    }
    element.textContent += graphemes[i];
    if (i < graphemes.length - 1) {
      const delay = computeDelay(graphemes, i);
      // eslint-disable-next-line no-await-in-loop
      await wait(delay);
    }
  }
  element.classList.add('sentence--complete');
}

function computeDelay(graphemes, index) {
  const char = graphemes[index] || '';
  const next = graphemes[index + 1] || '';
  const base = 1000 / Math.max(1, state.settings.cps);
  let extra = 0;
  if ('、，,'.includes(char)) {
    extra += 120;
  }
  if ('。．.!?！？'.includes(char)) {
    extra += 240;
  }
  if (char === '\n' && next === '\n') {
    extra += 300;
  }
  return (base + extra) * state.settings.pauseFactor;
}

function wait(duration) {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

async function playSentence(seq, token, sentenceIndex) {
  const chunks = await waitForSentenceAudio(seq, sentenceIndex);
  if (!isSequenceActive(seq, token) || !chunks || !chunks.length) {
    return;
  }
  const buffers = await getDecodedBuffers(seq, sentenceIndex, chunks);
  if (!isSequenceActive(seq, token) || !buffers.length) {
    return;
  }
  await audioManager.playBuffers(seq, token, buffers);
}

async function runSequence(seq, options = {}) {
  if (!isSequenceActive(seq, state.seqToken)) {
    return;
  }
  const token = state.seqToken;
  const page = getCurrentPage();
  if (!page) {
    return;
  }
  const fromSentence = Math.max(0, options.fromSentence || 0);
  for (let i = 0; i < fromSentence; i += 1) {
    const element = ensureSentenceElement(i);
    const sentence = page.sentences[i];
    if (element && sentence) {
      element.textContent = sentence.text;
      element.classList.add('sentence--complete');
    }
  }
  state.running = true;
  requestAhead(seq, fromSentence);
  for (let index = fromSentence; index < page.sentences.length; index += 1) {
    if (!isSequenceActive(seq, token)) {
      break;
    }
    const sentence = page.sentences[index];
    const element = ensureSentenceElement(index);
    requestAhead(seq, index);
    // eslint-disable-next-line no-await-in-loop
    await revealSentence(seq, token, sentence, element);
    if (!isSequenceActive(seq, token)) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await playSentence(seq, token, index);
    if (!isSequenceActive(seq, token)) {
      break;
    }
    state.sentenceIndex = index + 1;
    sendStatus();
  }
  state.running = false;
  sendStatus();
  if (isSequenceActive(seq, token) && state.sentenceIndex >= page.sentences.length) {
    setStatusHint('完了');
  }
}

function handleStart(message) {
  if (message.seq !== state.activeSeq) {
    return;
  }
  if (!state.readyByUser) {
    state.pendingStart = message;
    updateInteractionHint('クリックまたはキー操作でプレイバックを開始');
    return;
  }
  state.pendingStart = null;
  const resume = message.payload && message.payload.resume;
  const fromSentence = resume ? state.sentenceIndex : 0;
  state.sentenceIndex = fromSentence;
  setStatusHint(resume ? '再開' : '進行中');
  audioManager.resume();
  runSequence(message.seq, { fromSentence });
}

function handleClear(message) {
  if (typeof message.seq === 'number' && message.seq !== state.activeSeq) {
    resetForSequence(message.seq);
  }
  state.running = false;
  state.pendingStart = null;
  state.sentenceIndex = 0;
  state.requestedSentences.clear();
  audioManager.flush();
  clearAudioStore();
  clearContent();
  hideAnswerOverlay();
  setStatusHint('停止中');
  sendStatus();
}

function handleReveal(message) {
  if (message.seq !== state.activeSeq) {
    return;
  }
  showAnswerOverlay(message.payload || {});
  setStatusHint('解答表示中');
}

function handleTtsSentence(message) {
  if (message.seq !== state.activeSeq) {
    return;
  }
  if (!Array.isArray(message.chunks)) {
    return;
  }
  storeSentenceAudio(message.seq, message.sentence_index || 0, message.chunks);
  sendStatus();
}

function sendStatus() {
  const page = getCurrentPage();
  const totalPages = state.pages.length || 1;
  const currentSentenceCount = page ? page.sentences.length : 1;
  const payload = {
    page: Math.min(state.pageIndex + 1, totalPages),
    totalPages,
    sentenceIndex: Math.min(state.sentenceIndex + 1, currentSentenceCount || 1),
    ttsQueue: pendingAudioCount(),
  };
  sendMessage({ type: 'status', payload });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  const type = message.type;
  if (!type) {
    return;
  }
  switch (type) {
    case 'page_seq':
      handlePageSeq(message);
      break;
    case 'present':
      handlePresent(message);
      break;
    case 'settings':
      handleSettings(message);
      break;
    case 'start':
      handleStart(message);
      break;
    case 'clear':
      handleClear(message);
      break;
    case 'reveal':
      handleReveal(message);
      break;
    case 'tts_sentence':
      handleTtsSentence(message);
      break;
    default:
      console.warn('unknown message type', type);
  }
}

let bridgeConnection = null;
let bridgeReceiver = null;
let pendingBridgeMessages = [];
let readySent = false;
let presenterReadySent = false;

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
  readySent = false;
  presenterReadySent = false;
  setConnectionStage('disconnected');
}

function sendMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  const bridge = ensureBridge();
  try {
    bridge.send(message);
  } catch (err) {
    console.error('bridge send failed', err);
  }
}

function handleBridgePayload(raw) {
  if (!bridgeReceiver) {
    pendingBridgeMessages.push(raw);
    return;
  }
  bridgeReceiver(raw);
}

function parseBridgeMessage(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'object') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('failed to parse bridge message', err, raw);
    return null;
  }
}

function createWebSocketBridge(url) {
  const listeners = new Set();
  const openListeners = new Set();
  let socket = null;
  let manualClose = false;
  let reconnectTimer = null;
  const queue = [];

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
    if (socket) {
      try {
        socket.close();
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
      socket = new WebSocket(url);
      socket.onopen = () => {
        console.info(`bridge socket open url=${url}`);
        readySent = false;
        presenterReadySent = false;
        setConnectionStage('connected');
        if (queue.length) {
          const pending = queue.splice(0);
          pending.forEach((payload) => {
            try {
              socket.send(payload);
            } catch (err) {
              console.error('bridge queued send failed', err);
            }
          });
        }
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
        readySent = false;
        presenterReadySent = false;
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
        console.warn('bridge send queued until connection opens');
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
      queue.length = 0;
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
        console.info(`bridge event stream open url=${baseUrl}`);
        readySent = false;
        presenterReadySent = false;
        setConnectionStage('connected');
        notifyOpen();
      };
      source.onmessage = (event) => {
        notifyMessage(event.data);
      };
      source.onerror = () => {
        readySent = false;
        presenterReadySent = false;
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

function ensureBridge() {
  if (!bridgeConnection) {
    bridgeConnection = bridgeMode === 'http' ? createHttpBridge(bridgeHttpBase) : createWebSocketBridge(bridgeWsUrl);
    bridgeConnection.onMessage((message) => {
      const parsed = parseBridgeMessage(message);
      if (parsed) {
        handleBridgePayload(parsed);
      }
    });
    bridgeConnection.onOpen(() => {
      setConnectionStage('connected');
      if (!readySent) {
        sendMessage({ type: 'ready' });
        readySent = true;
      }
      if (state.readyByUser && !presenterReadySent) {
        sendMessage({ type: 'presenter_ready' });
        presenterReadySent = true;
      }
    });
  }
  return bridgeConnection;
}

function notifyPresenterReady() {
  if (!presenterReadySent) {
    sendMessage({ type: 'presenter_ready' });
    presenterReadySent = true;
  }
}

function handleUserReady() {
  if (state.readyByUser) {
    return;
  }
  state.readyByUser = true;
  updateReadyOverlay();
  updateInteractionHint('再生準備完了');
  audioManager.resume();
  notifyPresenterReady();
  if (state.pendingStart && state.pendingStart.seq === state.activeSeq) {
    const pending = state.pendingStart;
    state.pendingStart = null;
    handleStart(pending);
  }
}

function buildInfoLabel() {
  const version = params.get('v') || 'dev';
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Build: ${bridgeMode}@${version} ${stamp}`;
}

function init() {
  cacheElements();
  updateConnectionBadge();
  updateReadyOverlay();
  applySettings();
  setStatusHint('待機中');
  if (state.readyByUser) {
    updateInteractionHint('再生準備完了');
  } else {
    updateInteractionHint('クリックまたはキー操作で開始できます');
  }
  if (elements.buildInfo) {
    const label = buildInfoLabel();
    elements.buildInfo.textContent = label;
    console.info(label);
  }
  setBridgeReceiver((message) => {
    handleMessage(message);
  });
  ensureBridge();
}

document.addEventListener('DOMContentLoaded', init);

window.addEventListener('error', (event) => {
  const error = event.error || event.message || 'unknown error';
  sendMessage({ type: 'error', payload: { message: String(error) } });
});

window.addEventListener('beforeunload', () => {
  closeBridgeConnection();
});

document.addEventListener('pointerdown', handleUserReady, { once: true });
document.addEventListener('keydown', handleUserReady, { once: true });
