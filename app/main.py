import argparse
import base64
import json
import logging
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import requests

VOICEVOX_URL = "http://127.0.0.1:50021"
DEFAULT_SPEAKER = 1
MAX_CHARS_PER_TTS = 30
BRIDGE_WS = "ws"
BRIDGE_HTTP = "http"


@dataclass
class ReadingSpan:
    start: int
    end: int
    reading: str
    is_kana: bool = False

    def overlaps(self, other_start: int, other_end: int) -> bool:
        return not (self.end <= other_start or self.start >= other_end)


@dataclass
class QuizQuestion:
    identifier: int
    title: Optional[str]
    display_text: str
    answers: List[str]
    explain: Optional[str]
    spans: List[ReadingSpan] = field(default_factory=list)

    def get_tts_segments(self, start: int, end: int) -> List[Tuple[str, bool]]:
        if start >= end or start < 0:
            return []
        segments: List[Tuple[str, bool]] = []
        sorted_spans = sorted(self.spans, key=lambda s: (s.start, s.end))
        cursor = start
        for span in sorted_spans:
            if span.start < start or span.end > end:
                continue
            if cursor < span.start:
                prefix = self.display_text[cursor:span.start]
                if prefix:
                    segments.append((prefix, False))
                cursor = span.start
            if span.start >= start and span.end <= end:
                if span.reading:
                    segments.append((span.reading, span.is_kana))
                cursor = span.end
        if cursor < end:
            tail = self.display_text[cursor:end]
            if tail:
                segments.append((tail, False))
        return segments


def hira_to_kata(text: str) -> str:
    result = []
    for char in text:
        code = ord(char)
        if 0x3041 <= code <= 0x3096:
            result.append(chr(code + 0x60))
        else:
            result.append(char)
    return "".join(result)


def normalize_answer(value: str) -> str:
    return re.sub(r"\s+", "", value).strip().lower()


def prepare_tts_text(text: str) -> str:
    sanitized = text.replace("\n", "、")
    return sanitized.strip()


ruby_pattern = re.compile(r"([^^《》\s]+)《([^》]+)》")


def parse_question_text(raw_text: str, dictionaries: List[Dict[str, str]]) -> Tuple[str, List[ReadingSpan]]:
    spans: List[ReadingSpan] = []
    builder: List[str] = []
    index = 0
    length = len(raw_text)
    while index < length:
        if raw_text.startswith("{{AQUES|", index):
            end = raw_text.find("}}", index)
            if end == -1:
                content = raw_text[index + 8:]
                index = length
            else:
                content = raw_text[index + 8:end]
                index = end + 2
            start_pos = sum(len(part) for part in builder)
            builder.append(content)
            end_pos = start_pos + len(content)
            spans.append(ReadingSpan(start=start_pos, end=end_pos, reading=hira_to_kata(content), is_kana=True))
            continue
        match = ruby_pattern.match(raw_text, index)
        if match:
            surface = match.group(1)
            reading = match.group(2)
            start_pos = sum(len(part) for part in builder)
            builder.append(surface)
            end_pos = start_pos + len(surface)
            spans.append(ReadingSpan(start=start_pos, end=end_pos, reading=hira_to_kata(reading), is_kana=False))
            index += len(surface) + len(reading) + 2
            continue
        builder.append(raw_text[index])
        index += 1
    display_text = "".join(builder)

    def add_dictionary_entries(entries: Iterable[Dict[str, str]]) -> None:
        for entry in entries:
            surface = entry.get("surface", "").strip()
            yomi = entry.get("yomi", "").strip()
            if not surface or not yomi:
                continue
            reading_text = hira_to_kata(yomi)
            start_search = 0
            while True:
                found = display_text.find(surface, start_search)
                if found == -1:
                    break
                end_pos = found + len(surface)
                if any(span.overlaps(found, end_pos) for span in spans):
                    start_search = end_pos
                    continue
                spans.append(ReadingSpan(start=found, end=end_pos, reading=reading_text, is_kana=False))
                start_search = end_pos

    add_dictionary_entries(dictionaries)
    spans.sort(key=lambda s: (s.start, s.end))
    return display_text, spans


def parse_reading_block(lines: List[str]) -> List[Dict[str, str]]:
    entries: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("- "):
            if current:
                entries.append(current)
                current = {}
            line = line[2:]
        if ":" in line:
            key, value = line.split(":", 1)
            current[key.strip()] = value.strip()
    if current:
        entries.append(current)
    return entries


def parse_quiz_block(block: str, identifier: int, inherited_dictionary: List[Dict[str, str]]) -> Optional[QuizQuestion]:
    lines = block.strip().splitlines()
    if not lines:
        return None
    title: Optional[str] = None
    section: Optional[str] = None
    buffers: Dict[str, List[str]] = {"READING": [], "QUESTION": [], "ANSWER": [], "EXPLAIN": []}
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            title = stripped.lstrip("# ")
            continue
        header_match = re.match(r"^(READING|QUESTION|ANSWER|EXPLAIN):", stripped)
        if header_match:
            section = header_match.group(1)
            remainder = line.split(":", 1)[1]
            if remainder:
                buffers[section].append(remainder)
            continue
        if section:
            buffers[section].append(line)
    local_dict = parse_reading_block(buffers["READING"]) if buffers["READING"] else []
    dictionaries = [entry for entry in inherited_dictionary]
    dictionaries.extend(local_dict)
    question_text = "\n".join(buffers["QUESTION"]).strip()
    display_text, spans = parse_question_text(question_text, dictionaries)
    answers_line = "\n".join(buffers["ANSWER"]).strip()
    answers = [ans.strip() for ans in answers_line.split("｜") if ans.strip()]
    explain_text = "\n".join(buffers["EXPLAIN"]).strip() or None
    return QuizQuestion(
        identifier=identifier,
        title=title,
        display_text=display_text,
        answers=answers,
        explain=explain_text,
        spans=spans,
    )


def parse_quiz_file(path: str) -> List[QuizQuestion]:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    with open(path, "r", encoding="utf-8") as handle:
        content = handle.read()
    blocks = re.split(r"^---\s*$", content, flags=re.MULTILINE)
    questions: List[QuizQuestion] = []
    global_dict: List[Dict[str, str]] = []
    identifier = 1
    for block in blocks:
        stripped = block.strip()
        if not stripped:
            continue
        if stripped.startswith("READING:") and "QUESTION:" not in stripped:
            lines = stripped.splitlines()[1:]
            global_dict = parse_reading_block(lines)
            continue
        question = parse_quiz_block(stripped, identifier, global_dict)
        if question:
            questions.append(question)
            identifier += 1
    return questions


class TTSManager:
    def __init__(self, speaker: int = DEFAULT_SPEAKER) -> None:
        self.speaker = speaker
        self.session = requests.Session()
        self.available: Optional[bool] = None
        self.warning_displayed = False
        self.lock = threading.Lock()
        self._last_check = 0.0
        self._retry_interval = 10.0

    def check_service(self) -> bool:
        if self.available is True:
            return True
        with self.lock:
            if self.available is True:
                return True
            now = time.monotonic()
            if self.available is False and (now - self._last_check) < self._retry_interval:
                return False
            try:
                response = self.session.get(f"{VOICEVOX_URL}/version", timeout=2)
                self.available = response.ok
            except requests.RequestException:
                self.available = False
            finally:
                self._last_check = now
            return self.available

    def synthesize(self, text: str, is_kana: bool = False) -> Optional[str]:
        cleaned = prepare_tts_text(text)
        if not cleaned:
            return None
        if not self.check_service():
            return None
        try:
            query_response = self.session.post(
                f"{VOICEVOX_URL}/audio_query",
                params={
                    "text": cleaned,
                    "speaker": self.speaker,
                    "is_kana": "true" if is_kana else "false",
                },
                timeout=5,
            )
            query_response.raise_for_status()
            query = query_response.json()
            synth_response = self.session.post(
                f"{VOICEVOX_URL}/synthesis",
                params={"speaker": self.speaker},
                json=query,
                timeout=15,
            )
            synth_response.raise_for_status()
            encoded = base64.b64encode(synth_response.content).decode("ascii")
            return encoded
        except requests.RequestException as exc:
            logging.warning("VOICEVOX synthesis failed: %s", exc)
            return None


class BridgeClientBase:
    def start(self) -> None:
        raise NotImplementedError

    def send(self, action: str, data: Optional[Dict] = None) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


class WebSocketBridgeClient(BridgeClientBase):
    def __init__(self, host: str, port: int, callback: Callable[[Dict], None]) -> None:
        self.host = host
        self.port = port
        self.callback = callback
        self.loop = None
        self.thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.out_queue: "queue.Queue[Optional[str]]" = queue.Queue()

    def start(self) -> None:
        import asyncio
        import websockets

        if self.thread:
            return

        def runner() -> None:
            async def connect_loop() -> None:
                uri = f"ws://{self.host}:{self.port}/control"
                backoff = 0.5
                while not self.stop_event.is_set():
                    try:
                        async with websockets.connect(uri) as websocket:
                            backoff = 0.5
                            receiver = asyncio.create_task(self._receiver(websocket))
                            sender = asyncio.create_task(self._sender(websocket))
                            done, pending = await asyncio.wait(
                                [receiver, sender],
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                            for task in pending:
                                task.cancel()
                            for task in done:
                                if task.exception():
                                    raise task.exception()
                    except Exception as exc:  # pylint: disable=broad-except
                        logging.debug("WebSocket reconnect required: %s", exc)
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 5)

            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(connect_loop())

        self.thread = threading.Thread(target=runner, name="WebSocketBridge", daemon=True)
        self.thread.start()

    async def _receiver(self, websocket) -> None:  # type: ignore[override]
        import json as json_module

        async for message in websocket:
            try:
                payload = json_module.loads(message)
            except json_module.JSONDecodeError:
                logging.warning("Invalid JSON from presenter: %s", message)
                continue
            self.callback(payload)

    async def _sender(self, websocket) -> None:  # type: ignore[override]
        import asyncio

        loop = asyncio.get_event_loop()
        while not self.stop_event.is_set():
            try:
                message = await loop.run_in_executor(None, self.out_queue.get)
            except Exception:
                return
            if message is None:
                break
            await websocket.send(message)

    def send(self, action: str, data: Optional[Dict] = None) -> None:
        payload = json.dumps({"action": action, "data": data or {}})
        self.out_queue.put(payload)

    def close(self) -> None:
        self.stop_event.set()
        self.out_queue.put(None)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1)


class EventStreamReader(threading.Thread):
    def __init__(self, session: requests.Session, url: str, callback: Callable[[Dict], None], stop_event: threading.Event) -> None:
        super().__init__(name="SSEReader", daemon=True)
        self.session = session
        self.url = url
        self.callback = callback
        self.stop_event = stop_event

    def run(self) -> None:  # type: ignore[override]
        while not self.stop_event.is_set():
            try:
                with self.session.get(self.url, stream=True, timeout=30) as response:
                    if response.status_code != 200:
                        time.sleep(1)
                        continue
                    buffer = ""
                    for raw in response.iter_lines(decode_unicode=True):
                        if self.stop_event.is_set():
                            break
                        if raw is None:
                            continue
                        if raw.startswith("data:"):
                            buffer += raw[5:].strip()
                        elif raw == "":
                            if buffer:
                                try:
                                    payload = json.loads(buffer)
                                    self.callback(payload)
                                except json.JSONDecodeError:
                                    logging.warning("Malformed SSE payload: %s", buffer)
                                buffer = ""
                    time.sleep(0.2)
            except requests.RequestException as exc:
                logging.debug("SSE reconnect due to %s", exc)
                time.sleep(1)


class HttpBridgeClient(BridgeClientBase):
    def __init__(self, host: str, port: int, callback: Callable[[Dict], None]) -> None:
        self.host = host
        self.port = port
        self.callback = callback
        self.session = requests.Session()
        self.stop_event = threading.Event()
        self.reader: Optional[EventStreamReader] = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> None:
        if self.reader:
            return
        events_url = f"{self.base_url}/api/events"
        self.reader = EventStreamReader(self.session, events_url, self.callback, self.stop_event)
        self.reader.start()

    def send(self, action: str, data: Optional[Dict] = None) -> None:
        payload = {"action": action, "data": data or {}}
        try:
            response = self.session.post(f"{self.base_url}/api/cmd", json=payload, timeout=5)
            response.raise_for_status()
        except requests.RequestException as exc:
            logging.warning("HTTP bridge send failed: %s", exc)

    def close(self) -> None:
        self.stop_event.set()
        if self.reader and self.reader.is_alive():
            self.reader.join(timeout=1)


def find_free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class PresenterProcess:
    def __init__(self, mode: str, debug: bool, on_event: Callable[[Dict], None], port: Optional[int] = None) -> None:
        self.mode = mode
        self.debug = debug
        self.on_event = on_event
        self.port = port or find_free_port()
        self.process: Optional[subprocess.Popen] = None
        self.bridge: Optional[BridgeClientBase] = None

    def start(self) -> None:
        script_path = Path(__file__).with_name("presenter.py")
        debug_flag = "--debug" if self.debug else ""
        env = os.environ.copy()
        args = [sys.executable, str(script_path), "--bridge", self.mode, "--port", str(self.port)]
        if self.debug:
            args.append("--debug")
        self.process = subprocess.Popen(args, env=env)
        if self.mode == BRIDGE_WS:
            self.bridge = WebSocketBridgeClient("127.0.0.1", self.port, self.on_event)
        else:
            self.bridge = HttpBridgeClient("127.0.0.1", self.port, self.on_event)
        self.bridge.start()

    def send(self, action: str, data: Optional[Dict] = None) -> None:
        if not self.bridge:
            return
        self.bridge.send(action, data)

    def stop(self) -> None:
        if self.bridge:
            try:
                self.bridge.send("QUIT", {})
            except Exception:  # pylint: disable=broad-except
                pass
            self.bridge.close()
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


class QuizApp:
    def __init__(self, quiz_path: str, bridge_mode: str, debug: bool = False, port: Optional[int] = None) -> None:
        self.base_dir = Path(__file__).resolve().parent.parent
        os.chdir(self.base_dir)
        self.quiz_path = quiz_path
        self.bridge_mode = bridge_mode
        self.questions = parse_quiz_file(self.quiz_path)
        if not self.questions:
            raise RuntimeError("No quiz questions found.")
        self.root = tk.Tk()
        self.root.title("Quiz Control")
        self.ui_queue: "queue.Queue[Tuple[str, Optional[Dict]]]" = queue.Queue()
        self.debug_enabled = debug or os.environ.get("DEBUG") == "1"
        self.debug_until = time.time() + 30 if self.debug_enabled else 0.0
        self.presenter = PresenterProcess(bridge_mode, self.debug_enabled, self._handle_bridge_event, port=port)
        self.presenter.start()
        self.current_question: Optional[QuizQuestion] = None
        self.current_status: Dict[str, int] = {"page": 1, "totalPages": 1, "phraseIndex": 0, "ttsQueue": 0}
        self.tts_manager = TTSManager()
        self.voicevox_alerted = False
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.cps_var = tk.IntVar(value=14)
        self.pause_factor_var = tk.DoubleVar(value=1.0)
        self.zoom_var = tk.DoubleVar(value=1.10)
        self.compact_var = tk.BooleanVar(value=True)
        self.page_var = tk.StringVar(value="-")
        self.phrase_var = tk.StringVar(value="-")
        self.queue_var = tk.StringVar(value="0")
        self.voicevox_var = tk.StringVar(value="未確認")
        self.answer_text = tk.StringVar(value="")
        self.questions_listbox: Optional[tk.Listbox] = None
        self.presentation_ready = False
        self.closing = False
        self.create_control_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<space>", self.handle_stop_hotkey)
        self.root.bind("<Key-R>", self.handle_resume_hotkey)
        self.root.bind("<Key-r>", self.handle_resume_hotkey)
        self.root.bind("<Return>", self.handle_reveal_hotkey)
        self.root.bind("<Next>", self.handle_page_down)
        self.root.bind("<Prior>", self.handle_page_up)
        self.root.bind("<Escape>", self.handle_escape)
        if self.questions:
            self.set_current_question(0)
        self._drain_ui_queue()

    def _debug(self, message: str, *args: object) -> None:
        if not self.debug_enabled:
            return
        if self.debug_until and time.time() > self.debug_until:
            return
        logging.debug("[thread:%s] " + message, threading.current_thread().name, *args)

    def _handle_bridge_event(self, payload: Dict) -> None:
        self.ui_queue.put((payload.get("action", ""), payload.get("data")))

    def create_control_ui(self) -> None:
        main_frame = ttk.Frame(self.root, padding=12)
        main_frame.pack(fill=tk.BOTH, expand=True)

        left = ttk.Frame(main_frame)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        ttk.Label(left, text="問題一覧").pack(anchor=tk.W)
        listbox = tk.Listbox(left, height=10)
        listbox.pack(fill=tk.BOTH, expand=True, pady=(4, 8))
        for idx, question in enumerate(self.questions):
            title = question.title or f"Question {idx + 1}"
            listbox.insert(tk.END, f"{idx + 1}: {title}")
        listbox.bind("<<ListboxSelect>>", self.on_select_question)
        self.questions_listbox = listbox

        button_frame = ttk.Frame(left)
        button_frame.pack(fill=tk.X, pady=4)
        ttk.Button(button_frame, text="開始", command=self.start_presentation).pack(side=tk.LEFT, padx=2)
        ttk.Button(button_frame, text="停止", command=lambda: self.stop_presentation("manual")).pack(side=tk.LEFT, padx=2)
        ttk.Button(button_frame, text="再開", command=self.resume_presentation).pack(side=tk.LEFT, padx=2)
        ttk.Button(button_frame, text="正解表示", command=self.reveal_answer).pack(side=tk.LEFT, padx=2)

        ttk.Button(left, text="クイズを開く", command=self.load_quiz_file).pack(fill=tk.X, pady=4)

        right = ttk.Frame(main_frame, padding=(12, 0, 0, 0))
        right.pack(side=tk.LEFT, fill=tk.Y)

        control_frame = ttk.LabelFrame(right, text="設定")
        control_frame.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(control_frame, text="CPS (10-18)").grid(row=0, column=0, sticky=tk.W)
        cps_spin = ttk.Spinbox(control_frame, from_=10, to=18, textvariable=self.cps_var, width=5, command=self.update_cps)
        cps_spin.grid(row=0, column=1, sticky=tk.W)
        cps_spin.bind("<FocusOut>", lambda _event: self.update_cps())

        ttk.Label(control_frame, text="ポーズ係数 (0.8-1.4)").grid(row=1, column=0, sticky=tk.W)
        ttk.Scale(control_frame, from_=0.8, to=1.4, orient=tk.HORIZONTAL, variable=self.pause_factor_var, command=lambda _val: self.update_pause_factor()).grid(row=1, column=1, sticky=tk.EW)

        ttk.Label(control_frame, text="ズーム (0.85-1.4)").grid(row=2, column=0, sticky=tk.W)
        ttk.Scale(control_frame, from_=0.85, to=1.4, orient=tk.HORIZONTAL, variable=self.zoom_var, command=lambda _val: self.update_zoom()).grid(row=2, column=1, sticky=tk.EW)

        ttk.Checkbutton(control_frame, text="コンパクト表示", variable=self.compact_var, command=self.update_compact).grid(row=3, column=0, columnspan=2, sticky=tk.W)

        for i in range(2):
            control_frame.columnconfigure(i, weight=1)

        status_frame = ttk.LabelFrame(right, text="状態")
        status_frame.pack(fill=tk.X)

        ttk.Label(status_frame, text="ページ").grid(row=0, column=0, sticky=tk.W)
        ttk.Label(status_frame, textvariable=self.page_var).grid(row=0, column=1, sticky=tk.W)
        ttk.Label(status_frame, text="フレーズ").grid(row=1, column=0, sticky=tk.W)
        ttk.Label(status_frame, textvariable=self.phrase_var).grid(row=1, column=1, sticky=tk.W)
        ttk.Label(status_frame, text="TTSキュー").grid(row=2, column=0, sticky=tk.W)
        ttk.Label(status_frame, textvariable=self.queue_var).grid(row=2, column=1, sticky=tk.W)
        ttk.Label(status_frame, text="VOICEVOX").grid(row=3, column=0, sticky=tk.W)
        ttk.Label(status_frame, textvariable=self.voicevox_var).grid(row=3, column=1, sticky=tk.W)

        answer_frame = ttk.LabelFrame(right, text="正解")
        answer_frame.pack(fill=tk.BOTH, expand=True, pady=(8, 0))
        ttk.Label(answer_frame, textvariable=self.answer_text, wraplength=260, justify=tk.LEFT).pack(fill=tk.BOTH, expand=True)

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                event, payload = self.ui_queue.get_nowait()
                self._debug("dispatch %s", event)
                self._handle_event(event, payload)
        except queue.Empty:
            pass
        if not self.closing:
            self.root.after(50, self._drain_ui_queue)

    def _handle_event(self, event: str, payload: Optional[Dict]) -> None:
        if event == "READY":
            self.on_presentation_ready()
        elif event == "STATUS":
            if isinstance(payload, dict):
                self.update_status(payload)
        elif event == "TTS_REQUEST":
            if isinstance(payload, dict):
                self.handle_tts_request(payload)
        elif event == "ERROR":
            logging.error("Presentation error: %s", payload)
        elif event == "FINISHED":
            messagebox.showinfo("情報", "プレゼンテーションが終了しました。")
        elif event == "PONG":
            pass
        elif event == "VOICEVOX_UNAVAILABLE":
            if self.voicevox_alerted:
                messagebox.showwarning("VOICEVOX", "VOICEVOX が起動していない可能性があります。")

    def on_presentation_ready(self) -> None:
        if self.presentation_ready:
            return
        self.presentation_ready = True
        available = self.tts_manager.check_service()
        if available:
            self.voicevox_var.set("起動中")
            self.voicevox_alerted = False
        else:
            self.voicevox_var.set("未起動")
            self.voicevox_alerted = True
        if self.current_question is None and self.questions:
            self.set_current_question(0)
        self.sync_current_settings()

    def update_status(self, payload: Dict[str, int]) -> None:
        page = payload.get("page", 1)
        total = payload.get("totalPages", 1)
        phrase = payload.get("phraseIndex", 0)
        queue_len = payload.get("ttsQueue", 0)
        self.current_status = payload
        self.page_var.set(f"{page}/{total}")
        self.phrase_var.set(str(phrase))
        self.queue_var.set(str(queue_len))

    def handle_tts_request(self, payload: Dict) -> None:
        slices = payload.get("slice")
        if not isinstance(slices, list) or not self.current_question:
            return
        question = self.current_question

        def worker() -> None:
            chunks = []
            for item in slices:
                start = int(item.get("startChar", 0))
                end = int(item.get("endChar", 0))
                segments = question.get_tts_segments(start, end)
                texts = []
                for text, is_kana in segments:
                    if len(text) > MAX_CHARS_PER_TTS:
                        for idx in range(0, len(text), MAX_CHARS_PER_TTS):
                            texts.append((text[idx:idx + MAX_CHARS_PER_TTS], is_kana))
                    else:
                        texts.append((text, is_kana))
                for text, is_kana in texts:
                    wav = self.tts_manager.synthesize(text, is_kana=is_kana)
                    if wav:
                        chunk_id = f"chunk-{len(chunks)}"
                        chunks.append({"id": chunk_id, "wavBase64": wav})
            if chunks:
                for chunk in chunks:
                    self.presenter.send("play_chunk", chunk)
            elif not self.voicevox_alerted:
                self.voicevox_alerted = True
                self.ui_queue.put(("VOICEVOX_UNAVAILABLE", None))

        self.executor.submit(worker)

    def create_question_payload(self, question: QuizQuestion) -> Dict:
        return {
            "id": question.identifier,
            "text": question.display_text,
            "answers": question.answers,
            "explain": question.explain,
        }

    def sync_current_settings(self) -> None:
        if not self.presentation_ready or not self.current_question:
            return
        self.presenter.send("load_question", self.create_question_payload(self.current_question))
        self.presenter.send("set_cps", {"value": self.cps_var.get()})
        self.presenter.send("set_pause_factor", {"value": round(self.pause_factor_var.get(), 2)})
        self.presenter.send("set_zoom", {"value": round(self.zoom_var.get(), 2)})
        self.presenter.send("set_compact", {"value": bool(self.compact_var.get())})

    def set_current_question(self, index: int) -> None:
        if index < 0 or index >= len(self.questions):
            return
        self.current_question = self.questions[index]
        answers = " / ".join(self.current_question.answers)
        self.answer_text.set(answers)
        if self.questions_listbox:
            self.questions_listbox.select_clear(0, tk.END)
            self.questions_listbox.select_set(index)
            self.questions_listbox.activate(index)
        self.sync_current_settings()

    def on_select_question(self, event) -> None:
        if not self.questions_listbox:
            return
        selection = self.questions_listbox.curselection()
        if selection:
            self.set_current_question(selection[0])

    def start_presentation(self) -> None:
        if not self.presentation_ready or not self.current_question:
            messagebox.showwarning("未接続", "プレゼン画面が未接続です。")
            return
        self.presenter.send("start", {})

    def stop_presentation(self, reason: str) -> None:
        if not self.presentation_ready:
            return
        self.presenter.send("stop_all", {"reason": reason})

    def resume_presentation(self) -> None:
        if not self.presentation_ready:
            return
        self.presenter.send("resume", {})

    def reveal_answer(self) -> None:
        if not self.presentation_ready:
            return
        self.presenter.send("reveal_answer", {})

    def update_cps(self) -> None:
        value = max(10, min(18, self.cps_var.get()))
        self.cps_var.set(value)
        if self.presentation_ready:
            self.presenter.send("set_cps", {"value": value})

    def update_pause_factor(self) -> None:
        value = max(0.8, min(1.4, float(self.pause_factor_var.get())))
        self.pause_factor_var.set(value)
        if self.presentation_ready:
            self.presenter.send("set_pause_factor", {"value": round(value, 2)})

    def update_zoom(self) -> None:
        value = max(0.85, min(1.4, float(self.zoom_var.get())))
        self.zoom_var.set(value)
        if self.presentation_ready:
            self.presenter.send("set_zoom", {"value": round(value, 2)})

    def update_compact(self) -> None:
        if self.presentation_ready:
            self.presenter.send("set_compact", {"value": bool(self.compact_var.get())})

    def load_quiz_file(self) -> None:
        file_path = filedialog.askopenfilename(filetypes=[("Quiz", "*.txt"), ("All", "*.*")])
        if not file_path:
            return
        try:
            new_questions = parse_quiz_file(file_path)
        except Exception as exc:  # pylint: disable=broad-except
            messagebox.showerror("読み込みエラー", f"ファイルを読み込めませんでした:\n{exc}")
            return
        if not new_questions:
            messagebox.showinfo("情報", "問題が見つかりませんでした。")
            return
        self.questions = new_questions
        if self.questions_listbox:
            self.questions_listbox.delete(0, tk.END)
            for idx, question in enumerate(self.questions):
                title = question.title or f"Question {idx + 1}"
                self.questions_listbox.insert(tk.END, f"{idx + 1}: {title}")
        self.set_current_question(0)

    def handle_stop_hotkey(self, event) -> None:  # type: ignore[override]
        del event
        self.stop_presentation("hotkey")

    def handle_resume_hotkey(self, event) -> None:  # type: ignore[override]
        del event
        self.resume_presentation()

    def handle_reveal_hotkey(self, event) -> None:  # type: ignore[override]
        del event
        self.reveal_answer()

    def handle_page_down(self, event) -> None:  # type: ignore[override]
        del event
        current = max(self.current_status.get("page", 1) - 1, 0)
        total = max(self.current_status.get("totalPages", 1), 1)
        next_page = min(current + 1, total - 1)
        self.presenter.send("goto_page", {"page": next_page})

    def handle_page_up(self, event) -> None:  # type: ignore[override]
        del event
        current = max(self.current_status.get("page", 1) - 1, 0)
        prev_page = max(current - 1, 0)
        self.presenter.send("goto_page", {"page": prev_page})

    def handle_escape(self, event) -> None:  # type: ignore[override]
        del event
        self.stop_presentation("escape")

    def on_close(self) -> None:
        self.closing = True
        self.presenter.stop()
        try:
            self.executor.shutdown(wait=False)
        except Exception:  # pylint: disable=broad-except
            pass
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Quiz control application")
    parser.add_argument("quiz", nargs="?", default="samples/sample.quiz.txt")
    parser.add_argument("--bridge", choices=[BRIDGE_WS, BRIDGE_HTTP], default=BRIDGE_WS)
    parser.add_argument("--port", type=int, help="Bridge server port (optional)")
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv or sys.argv[1:])
    logging.basicConfig(level=logging.DEBUG if args.debug or os.environ.get("DEBUG") == "1" else logging.INFO)
    app = QuizApp(args.quiz, args.bridge, debug=args.debug, port=args.port)
    try:
        app.run()
    finally:
        app.presenter.stop()


if __name__ == "__main__":
    main()
