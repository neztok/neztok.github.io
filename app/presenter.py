import argparse
import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional

from aiohttp import WSMsgType, web
from urllib.parse import urlencode

BRIDGE_WS = "ws"
BRIDGE_HTTP = "http"


def env_flag(name: str) -> bool:
    value = os.environ.get(name)
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


class PresentationServer:
    def __init__(self, host: str, port: int, mode: str, debug: bool = False) -> None:
        self.host = host
        self.port = port
        self.mode = mode
        self.debug = debug
        self.loop = asyncio.new_event_loop()
        self.thread: Optional[threading.Thread] = None
        self.runner: Optional[web.AppRunner] = None
        self.site: Optional[web.TCPSite] = None
        self.ready_event = threading.Event()
        self.stop_event = threading.Event()
        self.start_exception: Optional[BaseException] = None
        self.web_dir = Path(__file__).resolve().parent.parent / "web"
        self.pending_to_control: List[str] = []
        self.pending_to_presentation: List[str] = []
        self.control_ws: Optional[web.WebSocketResponse] = None
        self.presentation_ws: Optional[web.WebSocketResponse] = None
        self.control_clients: List[asyncio.Queue] = []
        self.presentation_clients: List[asyncio.Queue] = []
        self.presentation_closed = False
        self._cors_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Credentials": "false",
        }
        self.app = web.Application()
        self._configure_routes()

    def _configure_routes(self) -> None:
        if self.mode == BRIDGE_WS:
            self.app.router.add_get("/control", self._handle_ws_control)
            self.app.router.add_get("/presentation", self._handle_ws_presentation)
        else:
            self.app.router.add_post("/api/cmd", self._handle_http_cmd)
            self.app.router.add_post("/api/presentation", self._handle_http_presentation)
            self.app.router.add_get("/api/events", self._handle_sse_control)
            self.app.router.add_get("/api/presentation/events", self._handle_sse_presentation)
            self.app.router.add_options("/api/{tail:.*}", self._handle_options)

        self.app.router.add_get("/", self._serve_index)
        self.app.router.add_get("/index.html", self._serve_index)
        self.app.router.add_get("/favicon.ico", self._serve_static)
        self.app.router.add_route("GET", "/{path:.*}", self._serve_static)
        self.app.router.add_route("HEAD", "/{path:.*}", self._serve_static)

    def start(self) -> None:
        if self.thread:
            return

        def runner() -> None:
            asyncio.set_event_loop(self.loop)
            try:
                self.loop.run_until_complete(self._start())
            except Exception as exc:  # pylint: disable=broad-except
                self.start_exception = exc
                self.ready_event.set()
            else:
                self.ready_event.set()
                try:
                    self.loop.run_forever()
                finally:
                    pass
            finally:
                with contextlib.suppress(Exception):
                    self.loop.run_until_complete(self._shutdown())
                self.loop.close()

        self.thread = threading.Thread(target=runner, name="PresentationServer", daemon=True)
        self.thread.start()
        self.ready_event.wait()
        if self.start_exception:
            raise RuntimeError("Presentation server failed to start") from self.start_exception

    async def _start(self) -> None:
        if not self.web_dir.exists():
            raise FileNotFoundError(f"Presentation assets directory not found: {self.web_dir}")
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, self.host, self.port)
        await self.site.start()
        logging.info("Presentation HTTP server running on http://%s:%d", self.host, self.port)

    async def _shutdown(self) -> None:
        self.stop_event.set()
        if self.control_ws and not self.control_ws.closed:
            await self.control_ws.close()
        if self.presentation_ws and not self.presentation_ws.closed:
            await self.presentation_ws.close()
        for queue in list(self.control_clients):
            queue.put_nowait(None)
        for queue in list(self.presentation_clients):
            queue.put_nowait(None)
        if self.site:
            await self.site.stop()
            self.site = None
        if self.runner:
            await self.runner.cleanup()
            self.runner = None

    def wait(self) -> None:
        if not self.thread:
            return
        try:
            while self.thread.is_alive():
                self.thread.join(timeout=0.5)
        except KeyboardInterrupt:
            pass

    def stop(self) -> None:
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def send_to_control(self, payload: Dict) -> None:
        message = json.dumps(payload)
        if self.mode == BRIDGE_WS:
            coro = self._forward_to_control_ws(message)
            pending = self.pending_to_control
        else:
            coro = self._broadcast_to_control_http(message)
            pending = self.pending_to_control
        if not self.loop.is_running() or self.loop.is_closed():
            pending.append(message)
            return
        try:
            asyncio.run_coroutine_threadsafe(coro, self.loop)
        except RuntimeError:
            pending.append(message)

    def send_to_presentation(self, payload: Dict) -> None:
        message = json.dumps(payload)
        if self.mode == BRIDGE_WS:
            coro = self._forward_to_presentation_ws(message)
            pending = self.pending_to_presentation
        else:
            coro = self._broadcast_to_presentation_http(message)
            pending = self.pending_to_presentation
        if not self.loop.is_running() or self.loop.is_closed():
            pending.append(message)
            return
        try:
            asyncio.run_coroutine_threadsafe(coro, self.loop)
        except RuntimeError:
            pending.append(message)

    async def _handle_ws_control(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.control_ws = ws
        await self._flush_pending(self.pending_to_control, ws)
        logging.info("WebSocket client connected: role=control")
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._forward_to_presentation_ws(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logging.warning("Control WebSocket error: %s", ws.exception())
        finally:
            self.control_ws = None
            logging.info("WebSocket client disconnected: role=control")
        return ws

    async def _handle_ws_presentation(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.presentation_ws = ws
        await self._flush_pending(self.pending_to_presentation, ws)
        logging.info("WebSocket client connected: role=presentation")
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._forward_to_control_ws(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logging.warning("Presentation WebSocket error: %s", ws.exception())
        finally:
            self.presentation_ws = None
            logging.info("WebSocket client disconnected: role=presentation")
            await self._handle_presentation_closed()
        return ws

    async def _forward_to_control_ws(self, message: str) -> None:
        if self.control_ws and not self.control_ws.closed:
            try:
                await self.control_ws.send_str(message)
                return
            except Exception:  # pylint: disable=broad-except
                logging.debug("Failed to send message to control WebSocket", exc_info=True)
        self.pending_to_control.append(message)

    async def _forward_to_presentation_ws(self, message: str) -> None:
        if self.presentation_ws and not self.presentation_ws.closed:
            try:
                await self.presentation_ws.send_str(message)
                return
            except Exception:  # pylint: disable=broad-except
                logging.debug("Failed to send message to presentation WebSocket", exc_info=True)
        self.pending_to_presentation.append(message)

    async def _flush_pending(self, pending: List[str], ws: web.WebSocketResponse) -> None:
        while pending:
            message = pending.pop(0)
            try:
                await ws.send_str(message)
            except Exception:  # pylint: disable=broad-except
                pending.insert(0, message)
                break

    async def _handle_http_cmd(self, request: web.Request) -> web.StreamResponse:
        try:
            payload = await request.json()
        except Exception:  # pylint: disable=broad-except
            return web.json_response({"ok": False}, status=400)
        await self._broadcast_to_presentation_http(json.dumps(payload))
        return self._json_ok()

    async def _handle_http_presentation(self, request: web.Request) -> web.StreamResponse:
        try:
            payload = await request.json()
        except Exception:  # pylint: disable=broad-except
            return web.json_response({"ok": False}, status=400)
        await self._broadcast_to_control_http(json.dumps(payload))
        return self._json_ok()

    def _json_ok(self) -> web.Response:
        response = web.json_response({"ok": True})
        self._apply_cors(response)
        return response

    def _apply_cors(self, response: web.StreamResponse) -> None:
        for key, value in self._cors_headers.items():
            response.headers[key] = value

    async def _handle_options(self, _: web.Request) -> web.StreamResponse:
        response = web.Response(status=204)
        self._apply_cors(response)
        return response

    async def _broadcast_to_control_http(self, message: str) -> None:
        queues = list(self.control_clients)
        if not queues:
            self.pending_to_control.append(message)
        for queue in queues:
            await queue.put(message)

    async def _broadcast_to_presentation_http(self, message: str) -> None:
        queues = list(self.presentation_clients)
        if not queues:
            self.pending_to_presentation.append(message)
        for queue in queues:
            await queue.put(message)

    async def _sse_endpoint(
        self,
        request: web.Request,
        queues: List[asyncio.Queue],
        pending: List[str],
        *,
        on_disconnect: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> web.StreamResponse:
        headers = {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
        headers.update(self._cors_headers)
        response = web.StreamResponse(status=200, reason="OK", headers=headers)
        await response.prepare(request)
        queue: asyncio.Queue = asyncio.Queue()
        queues.append(queue)
        try:
            for message in list(pending):
                await response.write(f"data: {message}\n\n".encode("utf-8"))
            pending.clear()
            while not self.stop_event.is_set():
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=1)
                except asyncio.TimeoutError:
                    await response.write(b":\n\n")
                    continue
                if message is None:
                    break
                await response.write(f"data: {message}\n\n".encode("utf-8"))
        except asyncio.CancelledError:
            pass
        finally:
            queues.remove(queue)
            with contextlib.suppress(ConnectionResetError):
                await response.write_eof()
            if on_disconnect and not self.stop_event.is_set() and not queues:
                await on_disconnect()
        return response

    async def _handle_sse_control(self, request: web.Request) -> web.StreamResponse:
        return await self._sse_endpoint(request, self.control_clients, self.pending_to_control)

    async def _handle_sse_presentation(self, request: web.Request) -> web.StreamResponse:
        async def notify_disconnect() -> None:
            await self._handle_presentation_closed()

        return await self._sse_endpoint(
            request,
            self.presentation_clients,
            self.pending_to_presentation,
            on_disconnect=notify_disconnect,
        )

    async def _handle_presentation_closed(self) -> None:
        if self.presentation_closed or self.stop_event.is_set():
            return
        self.presentation_closed = True
        await self._send_event_to_control("PRESENTATION_DISCONNECTED", {})
        await self._send_event_to_control("FINISHED", {})
        if self.loop.is_running() and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.loop.stop)

    async def _send_event_to_control(self, action: str, data: Dict) -> None:
        message = json.dumps({"action": action, "data": data})
        if self.mode == BRIDGE_WS:
            await self._forward_to_control_ws(message)
        else:
            await self._broadcast_to_control_http(message)

    async def _serve_index(self, request: web.Request) -> web.StreamResponse:
        return await self._serve_static(request, filename="index.html")

    async def _serve_static(self, request: web.Request, filename: Optional[str] = None) -> web.StreamResponse:
        if request.method not in {"GET", "HEAD"}:
            raise web.HTTPMethodNotAllowed(request.method, ["GET", "HEAD"])
        relative = filename or request.match_info.get("path", "")
        if not relative or relative == "/":
            relative = "index.html"
        safe_path = Path(relative.strip("/"))
        target = (self.web_dir / safe_path).resolve()
        try:
            target.relative_to(self.web_dir)
        except ValueError as exc:
            raise web.HTTPNotFound() from exc
        if target.is_dir():
            target = target / "index.html"
        if not target.exists() or not target.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(target)


class PresenterApp:
    def __init__(self, bridge: str, port: int, debug: bool = False) -> None:
        self.bridge_mode = bridge
        self.port = port
        self.debug = debug or env_flag("DEBUG")
        self.server = PresentationServer("127.0.0.1", port, bridge, debug=self.debug)
        self.asset_version = os.environ.get("PRESENTATION_INDEX_VERSION") or str(int(time.time()))

    def run(self) -> None:
        try:
            self.server.start()
        except RuntimeError as exc:
            logging.error("Failed to start presentation server: %s", exc)
            sys.exit(1)
        base_url = f"http://127.0.0.1:{self.port}/"
        query = {
            "mode": self.bridge_mode,
            "port": str(self.port),
            "v": self.asset_version,
        }
        presentation_url = f"{base_url}?{urlencode(query)}"
        logging.info("Presentation URL: %s", presentation_url)
        opened = False
        try:
            opened = webbrowser.open(presentation_url, new=1, autoraise=True)
        except Exception as exc:  # pylint: disable=broad-except
            logging.warning("Failed to launch default browser: %s", exc)
        if opened:
            logging.info("Opened presentation in the default browser.")
        else:
            logging.warning("Could not open browser automatically. Navigate to this URL manually: %s", presentation_url)
            print(presentation_url, file=sys.stdout)
        self.server.wait()

    def stop(self) -> None:
        self.server.stop()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Presentation process")
    parser.add_argument("--bridge", choices=[BRIDGE_WS, BRIDGE_HTTP], default=BRIDGE_WS)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    debug_enabled = args.debug or env_flag("DEBUG")
    logging.basicConfig(level=logging.DEBUG if debug_enabled else logging.INFO)
    app = PresenterApp(args.bridge, args.port, debug=debug_enabled)
    try:
        app.run()
    finally:
        app.stop()


if __name__ == "__main__":
    main()
