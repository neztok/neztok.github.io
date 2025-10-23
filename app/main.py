import argparse
import base64
import json
import logging
import os
import queue
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import requests
import webview

VOICEVOX_URL = "http://127.0.0.1:50021"
DEFAULT_SPEAKER = 1
MAX_CHARS_PER_TTS = 30


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

    def add_dictionary_entries(entries: List[Dict[str, str]]) -> None:
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


def select_webview_gui() -> Optional[str]:
    env_gui = os.environ.get("PYWEBVIEW_GUI")
    if env_gui:
        logging.info("Using pywebview GUI backend from PYWEBVIEW_GUI=%s", env_gui)
        return env_gui
    if sys.platform.startswith("win"):
        try:
            from webview.platforms import edgechromium  # type: ignore

            if edgechromium.is_available():  # type: ignore[attr-defined]
                logging.info("Detected Edge (WebView2) runtime. Selecting edgechromium backend.")
                return "edgechromium"
            logging.info("Edge (WebView2) backend not available. Falling back to default GUI backend.")
        except Exception as exc:  # pylint: disable=broad-except
            logging.debug("Edge backend detection failed: %s", exc)
    else:
        logging.info("Non-Windows platform detected. Using pywebview default GUI backend.")
    return None


class TTSManager:
    def __init__(self, speaker: int = DEFAULT_SPEAKER) -> None:
        self.speaker = speaker
        self.session = requests.Session()
        self.available: Optional[bool] = None
        self.warning_displayed = False
        self.lock = threading.Lock()

    def check_service(self) -> bool:
        if self.available is not None:
            return self.available
        try:
            response = self.session.get(f"{VOICEVOX_URL}/version", timeout=2)
            self.available = response.ok
        except requests.RequestException:
            self.available = False
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


class Bridge:
    __slots__ = ("ui_queue",)

    def __init__(self, ui_queue: "queue.Queue") -> None:
        self.ui_queue = ui_queue

    def _emit(self, event: str, payload: Optional[Dict] = None) -> bool:
        self.ui_queue.put((event, payload))
        return True

    def notify_ready(self) -> bool:
        return self._emit("PRESENTATION_READY")

    def request_tts_chunks(self, payload: Dict[str, List[Dict[str, int]]]) -> bool:
        return self._emit("TTS_REQUEST", payload)

    def status(self, payload: Dict[str, int]) -> bool:
        return self._emit("STATUS", payload)

    def error(self, payload: Dict[str, str]) -> bool:
        return self._emit("ERROR", payload)


class QuizApp:
    def __init__(self, quiz_path: str, debug: bool = False) -> None:
        self.base_dir = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
        os.chdir(self.base_dir)
        self.quiz_path = quiz_path
        self.questions = parse_quiz_file(self.quiz_path)
        if not self.questions:
            raise RuntimeError("No quiz questions found.")
        self.root = tk.Tk()
        self.root.title("Quiz Control")
        self.main_thread = threading.current_thread()
        self.ui_queue: queue.Queue = queue.Queue()
        self.bridge = Bridge(self.ui_queue)
        self.window: Optional[webview.Window] = None
        self.webview_ready = False
        self.presentation_ready = False
        self.current_question: Optional[QuizQuestion] = None
        self.current_status: Dict[str, int] = {"page": 1, "totalPages": 1, "phraseIndex": 0, "ttsQueue": 0}
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.tts_manager = TTSManager()
        self.voicevox_alerted = False
        self.cps_var = tk.IntVar(value=14)
        self.pause_factor_var = tk.DoubleVar(value=1.0)
        self.zoom_var = tk.DoubleVar(value=1.10)
        self.compact_var = tk.BooleanVar(value=True)
        self.page_var = tk.StringVar(value="-")
        self.phrase_var = tk.StringVar(value="-")
        self.queue_var = tk.StringVar(value="0")
        self.voicevox_var = tk.StringVar(value="未確認")
        self.questions_listbox: Optional[tk.Listbox] = None
        self.answer_text = tk.StringVar(value="")
        self.debug_enabled = debug or os.environ.get("DEBUG") == "1"
        self.debug_until = time.time() + 30 if self.debug_enabled else 0.0
        if self.debug_enabled:
            logging.info("Event flow debug logging enabled for 30 seconds.")
        self.create_control_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<space>", self.handle_stop_hotkey)
        self.root.bind("<Key-R>", self.handle_resume_hotkey)
        self.root.bind("<Key-r>", self.handle_resume_hotkey)
        self.root.bind("<Return>", self.handle_reveal_hotkey)
        self.root.bind("<Next>", self.handle_page_down)
        self.root.bind("<Prior>", self.handle_page_up)
        self.root.bind("<Escape>", self.handle_escape)
        self.root.after(50, self._drain_ui_queue)
        if self.questions:
            self.set_current_question(0)

    def _debug(self, message: str, *args: object) -> None:
        if not self.debug_enabled:
            return
        if self.debug_until and time.time() > self.debug_until:
            return
        logging.debug("[thread:%s] " + message, threading.current_thread().name, *args)

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
        ttk.Label(answer_frame, textvariable=self.answer_text, wraplength=280, justify=tk.LEFT).pack(anchor=tk.W, padx=4, pady=4)

    def _on_ui_thread(self) -> bool:
        return threading.current_thread() is self.main_thread

    def post_ui_event(self, event: str, payload: Optional[Dict] = None) -> None:
        self._debug("queue %s", event)
        self.ui_queue.put((event, payload))

    def on_select_question(self, _event: object) -> None:
        if not self.questions_listbox:
            return
        selection = self.questions_listbox.curselection()
        if not selection:
            return
        index = selection[0]
        self.set_current_question(index, ensure_selection=False)

    def set_current_question(self, index: int, *, ensure_selection: bool = True) -> None:
        if index < 0 or index >= len(self.questions):
            return
        if not self._on_ui_thread():
            self.post_ui_event("SELECT_QUESTION", {"index": index, "ensure_selection": ensure_selection})
            return
        self._apply_question_selection(index, ensure_selection=ensure_selection)

    def _apply_question_selection(self, index: int, *, ensure_selection: bool = True) -> None:
        if index < 0 or index >= len(self.questions):
            return
        self.current_question = self.questions[index]
        answers = " / ".join(self.current_question.answers)
        self.answer_text.set(answers)
        if ensure_selection and self.questions_listbox:
            self.questions_listbox.selection_clear(0, tk.END)
            self.questions_listbox.selection_set(index)
            self.questions_listbox.see(index)
        self._sync_current_question()

    def _sync_current_question(self) -> None:
        if not (self.presentation_ready and self.webview_ready):
            return
        if not self.current_question:
            return
        payload = self.build_question_payload(self.current_question)
        self.send_command("load_question", payload)
        self.send_command("set_cps", {"value": self.cps_var.get()})
        self.send_command("set_pause_factor", {"value": round(self.pause_factor_var.get(), 2)})
        self.send_command("set_zoom", {"value": round(self.zoom_var.get(), 2)})
        self.send_command("set_compact", {"value": bool(self.compact_var.get())})

    def build_question_payload(self, question: QuizQuestion) -> Dict:
        return {
            "id": question.identifier,
            "title": question.title,
            "text": question.display_text,
            "answers": question.answers,
            "explain": question.explain,
        }

    def load_quiz_file(self) -> None:
        file_path = filedialog.askopenfilename(
            title="クイズファイルを選択",
            filetypes=[("Quiz text", "*.txt"), ("All files", "*.*")],
        )
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
        self._repopulate_question_listbox()
        self.set_current_question(0)

    def _repopulate_question_listbox(self) -> None:
        if not self.questions_listbox:
            return
        self.questions_listbox.delete(0, tk.END)
        for idx, question in enumerate(self.questions):
            title = question.title or f"Question {idx + 1}"
            self.questions_listbox.insert(tk.END, f"{idx + 1}: {title}")

    def start_presentation(self) -> None:
        if not self.presentation_ready:
            messagebox.showwarning("未接続", "プレゼン画面が未接続です。")
            return
        if not self.current_question:
            self.set_current_question(0)
        if not self.current_question:
            return
        self.send_command("load_question", self.build_question_payload(self.current_question))
        self.send_command("set_cps", {"value": self.cps_var.get()})
        self.send_command("set_pause_factor", {"value": round(self.pause_factor_var.get(), 2)})
        self.send_command("set_zoom", {"value": round(self.zoom_var.get(), 2)})
        self.send_command("set_compact", {"value": bool(self.compact_var.get())})
        self.send_command("start", {"fromPage": max(self.current_status.get("page", 1) - 1, 0)})

    def stop_presentation(self, reason: str) -> None:
        if not self.presentation_ready:
            return
        self.send_command("stop_all", {"reason": reason})
        self.send_command("flush_audio", {})

    def resume_presentation(self) -> None:
        if not self.presentation_ready:
            return
        self.send_command("resume", {})

    def reveal_answer(self) -> None:
        if not self.presentation_ready:
            return
        self.send_command("reveal_answer", {})

    def update_cps(self) -> None:
        value = max(10, min(18, self.cps_var.get()))
        self.cps_var.set(value)
        if self.presentation_ready:
            self.send_command("set_cps", {"value": value})

    def update_pause_factor(self) -> None:
        value = max(0.8, min(1.4, float(self.pause_factor_var.get())))
        self.pause_factor_var.set(value)
        if self.presentation_ready:
            self.send_command("set_pause_factor", {"value": round(value, 2)})

    def update_zoom(self) -> None:
        value = max(0.85, min(1.4, float(self.zoom_var.get())))
        self.zoom_var.set(value)
        if self.presentation_ready:
            self.send_command("set_zoom", {"value": round(value, 2)})

    def update_compact(self) -> None:
        if self.presentation_ready:
            self.send_command("set_compact", {"value": bool(self.compact_var.get())})

    def on_presentation_ready(self) -> None:
        if self.presentation_ready:
            self._debug("presentation bridge already initialized")
            return
        self.presentation_ready = True
        self._debug("presentation bridge ready")
        self.voicevox_var.set("確認中")
        available = self.tts_manager.check_service()
        if available:
            self.voicevox_var.set("起動中")
            self.voicevox_alerted = False
        else:
            self.voicevox_var.set("未起動")
            self.voicevox_alerted = True
        if self.questions and self.current_question is None:
            self.set_current_question(0)
        self._sync_current_question()

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                event, payload = self.ui_queue.get_nowait()
                self._debug("dispatch %s", event)
                self._handle_ui_event(event, payload)
        except queue.Empty:
            pass
        self.root.after(50, self._drain_ui_queue)

    def _handle_ui_event(self, event: str, payload: Optional[Dict]) -> None:
        if event == "WEBVIEW_READY":
            self._on_webview_ready_mainthread()
        elif event == "PRESENTATION_READY":
            self.on_presentation_ready()
        elif event == "TTS_REQUEST":
            if isinstance(payload, dict):
                self.handle_tts_request(payload)
        elif event == "STATUS":
            if isinstance(payload, dict):
                self.update_status(payload)
        elif event == "ERROR":
            logging.error("Presentation error: %s", payload)
        elif event == "PLAY_CHUNK":
            if isinstance(payload, dict):
                self.send_command("play_chunk", payload)
        elif event == "VOICEVOX_UNAVAILABLE":
            self._handle_voicevox_unavailable()
        elif event == "SELECT_QUESTION":
            if isinstance(payload, dict) and "index" in payload:
                ensure = bool(payload.get("ensure_selection", True))
                try:
                    index = int(payload.get("index"))
                except (TypeError, ValueError):
                    return
                self._apply_question_selection(index, ensure_selection=ensure)

    def _on_webview_ready_mainthread(self) -> None:
        if self.webview_ready:
            return
        self.webview_ready = True
        self._debug("webview ready acknowledged")
        self._sync_current_question()

    def _handle_voicevox_unavailable(self) -> None:
        if self.voicevox_alerted:
            return
        self.voicevox_alerted = True
        self.voicevox_var.set("未起動")
        logging.warning("VOICEVOX is not available. Proceeding silently.")

    def handle_tts_request(self, payload: Optional[Dict[str, List[Dict[str, int]]]]) -> None:
        if not self.current_question or not payload:
            return
        slices = payload.get("slice", [])
        for item in slices:
            start = item.get("start")
            end = item.get("end")
            chunk_id = item.get("id")
            if start is None or end is None or chunk_id is None:
                continue
            segments = self.current_question.get_tts_segments(start, end)
            if not segments:
                text = self.current_question.display_text[start:end]
                segments = [(text, False)]
            sub_index = 0
            for text, is_kana in segments:
                for part in self.split_for_limits(text):
                    actual_id = f"{chunk_id}:{sub_index}"
                    sub_index += 1
                    self.executor.submit(self.generate_chunk, actual_id, part, is_kana)

    def split_for_limits(self, text: str) -> List[str]:
        if len(text) <= MAX_CHARS_PER_TTS:
            return [text]
        parts: List[str] = []
        buffer = ""
        for char in text:
            buffer += char
            if len(buffer) >= MAX_CHARS_PER_TTS:
                parts.append(buffer)
                buffer = ""
        if buffer:
            parts.append(buffer)
        return parts

    def generate_chunk(self, chunk_id: str, text: str, is_kana: bool) -> None:
        audio = self.tts_manager.synthesize(text, is_kana=is_kana)
        if audio:
            self.post_ui_event("PLAY_CHUNK", {"id": chunk_id, "wavBase64": audio})
        elif not self.tts_manager.check_service():
            self.post_ui_event("VOICEVOX_UNAVAILABLE")
        else:
            self._debug("No audio generated for chunk %s", chunk_id)

    def update_status(self, payload: Dict[str, int]) -> None:
        self.current_status.update(payload)
        page = payload.get("page", 1)
        total = payload.get("totalPages", 1)
        self.page_var.set(f"{page} / {total}")
        phrase = payload.get("phraseIndex", 0)
        self.phrase_var.set(str(phrase))
        queue_len = payload.get("ttsQueue", 0)
        self.queue_var.set(str(queue_len))

    def send_command(self, action: str, data: Dict) -> None:
        if not self.window or not self.webview_ready:
            self._debug("skip %s (webview not ready)", action)
            return
        message = json.dumps({"action": action, "data": data}, ensure_ascii=False)
        script = f"window.appBridge && window.appBridge.receive({message});"
        self._debug("send %s", action)
        try:
            self.window.evaluate_js(script)
        except Exception as exc:  # pylint: disable=broad-except
            logging.error("Failed to send command %s: %s", action, exc)

    def handle_stop_hotkey(self, _event: tk.Event) -> str:
        self.stop_presentation("hotkey")
        return "break"

    def handle_resume_hotkey(self, _event: tk.Event) -> str:
        self.resume_presentation()
        return "break"

    def handle_reveal_hotkey(self, _event: tk.Event) -> str:
        self.reveal_answer()
        return "break"

    def handle_page_down(self, _event: tk.Event) -> str:
        if not self.presentation_ready:
            return "break"
        page = self.current_status.get("page", 1)
        total = self.current_status.get("totalPages", 1)
        if page < total:
            self.send_command("goto_page", {"page": page})
        return "break"

    def handle_page_up(self, _event: tk.Event) -> str:
        if not self.presentation_ready:
            return "break"
        page = self.current_status.get("page", 1)
        if page > 1:
            self.send_command("goto_page", {"page": page - 2})
        return "break"

    def handle_escape(self, _event: tk.Event) -> str:
        self.on_close()
        return "break"

    def on_close(self) -> None:
        try:
            self.executor.shutdown(wait=False, cancel_futures=True)
        except TypeError:
            self.executor.shutdown(wait=False)
        if self.window:
            try:
                webview.destroy_window(self.window)
            except Exception:  # pylint: disable=broad-except
                pass
        self.root.destroy()

    def run(self) -> None:
        index_uri = (Path(self.base_dir) / "web" / "index.html").resolve().as_uri()
        backend = select_webview_gui()
        backend_label = backend or "default"
        logging.info("Using pywebview GUI backend: %s", backend_label)
        if self.debug_enabled:
            self._debug("webview start backend=%s url=%s", backend_label, index_uri)
        self.window = webview.create_window(
            "Quiz Presentation",
            url=index_uri,
            js_api=self.bridge,
            width=1600,
            height=900,
            resizable=True,
        )
        start_kwargs = {"func": self.on_webview_ready}
        if backend:
            start_kwargs["gui"] = backend
        webview.start(**start_kwargs)

    def on_webview_ready(self) -> None:
        self.post_ui_event("WEBVIEW_READY")


def main() -> None:
    base_dir = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
    default_quiz = os.path.join(base_dir, "samples", "sample.quiz.txt")
    parser = argparse.ArgumentParser(description="Quiz presentation control app")
    parser.add_argument("--quiz", default=default_quiz, help="Path to quiz file (default: samples/sample.quiz.txt)")
    parser.add_argument("--debug", action="store_true", help="Enable event flow debug logging for 30 seconds")
    args = parser.parse_args()
    debug_env = os.environ.get("DEBUG") == "1"
    log_level = logging.DEBUG if args.debug or debug_env else logging.INFO
    logging.basicConfig(level=log_level, format="[%(levelname)s] %(message)s")
    quiz_path = args.quiz or default_quiz
    app = QuizApp(quiz_path, debug=args.debug or debug_env)
    app.run()


if __name__ == "__main__":
    main()
