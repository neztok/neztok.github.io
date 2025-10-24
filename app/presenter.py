import argparse
import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import unquote
from typing import Awaitable, Callable, Dict, List, Optional

import webview

BRIDGE_WS = "ws"
BRIDGE_HTTP = "http"


def select_webview_gui() -> Optional[str]:
    env_gui = os.environ.get("PYWEBVIEW_GUI")
    if env_gui:
        logging.info("Using pywebview GUI backend from PYWEBVIEW_GUI=%s", env_gui)
        return env_gui
    if os.name == "nt":
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


class BridgeServerBase:
    def start(self) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError

    def send_to_control(self, payload: Dict) -> None:
        raise NotImplementedError

    def send_to_presentation(self, payload: Dict) -> None:
        raise NotImplementedError


class WebSocketBridgeServer(BridgeServerBase):
    def __init__(self, host: str, port: int, debug: bool = False) -> None:
        self.host = host
        self.port = port
        self.debug = debug
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.thread: Optional[threading.Thread] = None
        self.server = None
        self.control_conn = None
        self.presentation_conn = None
        self.pending_to_control: List[str] = []
        self.pending_to_presentation: List[str] = []
        self.ready_event = threading.Event()
        self.stop_event = threading.Event()
        self.start_exception: Optional[BaseException] = None
        self._stop_future: Optional[asyncio.Future] = None

    def start(self) -> None:
        import websockets

        if self.thread:
            return

        def runner() -> None:
            loop = asyncio.new_event_loop()
            self.loop = loop
            asyncio.set_event_loop(loop)

            async def handler(websocket):  # type: ignore
                raw_path = getattr(websocket, "path", "/")
                path = raw_path
                if path == "/":
                    logging.warning(
                        "WebSocket client connected without explicit path; treating as /presentation (compat)",
                    )
                    # TODO: Remove this fallback after legacy clients are updated.
                    path = "/presentation"
                logging.info("WebSocket client connected: path=%s", path)
                try:
                    if path == "/control":
                        await self._handle_control(websocket)
                    elif path == "/presentation":
                        await self._handle_presentation(websocket)
                    else:
                        logging.warning("Unsupported WebSocket path: %s", raw_path)
                        await websocket.close(code=1008, reason="unsupported path")
                except Exception:  # pylint: disable=broad-except
                    logging.exception("Unhandled error in WebSocket handler (path=%s)", path)
                    raise
                finally:
                    code = getattr(websocket, "close_code", None)
                    reason = getattr(websocket, "close_reason", "")
                    logging.info(
                        "WebSocket client disconnected: path=%s code=%s reason=%s",
                        path,
                        code,
                        reason,
                    )

            async def ws_main() -> None:
                try:
                    async with websockets.serve(handler, self.host, self.port) as server:
                        self.server = server
                        logging.info("WebSocket bridge listening on ws://%s:%d", self.host, self.port)
                        self._stop_future = asyncio.get_running_loop().create_future()
                        self.ready_event.set()
                        await self._stop_future
                except Exception as exc:  # pylint: disable=broad-except
                    self.start_exception = exc
                    if isinstance(exc, OSError):
                        logging.error("WebSocket bridge failed to bind %s:%d: %s", self.host, self.port, exc)
                    else:
                        logging.error("WebSocket bridge stopped unexpectedly: %s", exc)
                    if not self.ready_event.is_set():
                        self.ready_event.set()
                finally:
                    await self._close_all()

            try:
                loop.run_until_complete(ws_main())
            finally:
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                with contextlib.suppress(Exception):
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()

        self.thread = threading.Thread(target=runner, name="WSBridgeServer", daemon=True)
        self.thread.start()
        self.ready_event.wait()
        if self.start_exception:
            raise RuntimeError("WebSocket bridge failed to start") from self.start_exception

    async def _close_all(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for conn in [self.control_conn, self.presentation_conn]:
            if conn:
                with contextlib.suppress(Exception):
                    await conn.close()

    async def _handle_control(self, websocket) -> None:
        import websockets

        self.control_conn = websocket
        await self._flush_pending(self.pending_to_control, websocket)
        try:
            async for message in websocket:
                await self._forward_to_presentation(message)
        except websockets.exceptions.ConnectionClosed as err:  # type: ignore[attr-defined]
            logging.info(
                "Control connection closed: code=%s reason=%s",
                err.code,
                err.reason,
            )
        except Exception:
            logging.exception("Control connection error")
            raise
        finally:
            self.control_conn = None

    async def _handle_presentation(self, websocket) -> None:
        import websockets

        self.presentation_conn = websocket
        await self._flush_pending(self.pending_to_presentation, websocket)
        try:
            async for message in websocket:
                await self._forward_to_control(message)
        except websockets.exceptions.ConnectionClosed as err:  # type: ignore[attr-defined]
            logging.info(
                "Presentation connection closed: code=%s reason=%s",
                err.code,
                err.reason,
            )
        except Exception:
            logging.exception("Presentation connection error")
            raise
        finally:
            self.presentation_conn = None
            if not self.stop_event.is_set():
                self.send_to_control({"action": "PRESENTATION_DISCONNECTED", "data": {}})

    async def _flush_pending(self, pending: List[str], websocket) -> None:
        while pending:
            message = pending.pop(0)
            try:
                await websocket.send(message)
            except Exception:  # pylint: disable=broad-except
                pending.insert(0, message)
                break

    async def _forward_to_presentation(self, message: str) -> None:
        if self.presentation_conn:
            try:
                await self.presentation_conn.send(message)
                return
            except Exception:  # pylint: disable=broad-except
                pass
        self.pending_to_presentation.append(message)

    async def _forward_to_control(self, message: str) -> None:
        if self.control_conn:
            try:
                await self.control_conn.send(message)
                return
            except Exception:  # pylint: disable=broad-except
                pass
        self.pending_to_control.append(message)

    def stop(self) -> None:
        self.stop_event.set()
        if self.loop and self._stop_future and not self._stop_future.done():
            self.loop.call_soon_threadsafe(self._stop_future.set_result, None)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def send_to_control(self, payload: Dict) -> None:
        if not self.loop or self.loop.is_closed() or self.start_exception:
            return
        message = json.dumps(payload)

        async def _send() -> None:
            await self._forward_to_control(message)

        asyncio.run_coroutine_threadsafe(_send(), self.loop)

    def send_to_presentation(self, payload: Dict) -> None:
        if not self.loop or self.loop.is_closed() or self.start_exception:
            return
        message = json.dumps(payload)

        async def _send() -> None:
            await self._forward_to_presentation(message)

        asyncio.run_coroutine_threadsafe(_send(), self.loop)


class HttpBridgeServer(BridgeServerBase):
    def __init__(self, host: str, port: int, debug: bool = False) -> None:
        from aiohttp import web

        self.host = host
        self.port = port
        self.debug = debug
        self.loop = asyncio.new_event_loop()
        self.thread: Optional[threading.Thread] = None
        self._cors_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Credentials": "false",
        }

        @web.middleware
        async def cors_middleware(request, handler):  # type: ignore
            if request.method == "OPTIONS":
                return self._apply_cors(web.Response(status=204))
            response = await handler(request)
            return self._apply_cors(response)

        self.app = web.Application(middlewares=[cors_middleware])
        self.runner: Optional[web.AppRunner] = None
        self.site: Optional[web.TCPSite] = None
        self.control_clients: List[asyncio.Queue] = []
        self.presentation_clients: List[asyncio.Queue] = []
        self.pending_to_control: List[str] = []
        self.pending_to_presentation: List[str] = []
        self.ready_event = threading.Event()
        self.stop_event = threading.Event()
        self._configure_routes()

    def _apply_cors(self, resp):
        for key, value in self._cors_headers.items():
            resp.headers[key] = value
        return resp

    def _configure_routes(self) -> None:
        from aiohttp import web

        async def post_cmd(request: web.Request) -> web.StreamResponse:
            try:
                payload = await request.json()
            except Exception:  # pylint: disable=broad-except
                return web.json_response({"ok": False}, status=400)
            await self._broadcast_to_presentation(json.dumps(payload))
            return web.json_response({"ok": True})

        async def post_presentation(request: web.Request) -> web.StreamResponse:
            try:
                payload = await request.json()
            except Exception:  # pylint: disable=broad-except
                return web.json_response({"ok": False}, status=400)
            await self._broadcast_to_control(json.dumps(payload))
            return web.json_response({"ok": True})

        async def sse_control(request: web.Request) -> web.StreamResponse:
            return await self._sse_endpoint(request, self.control_clients, self.pending_to_control)

        async def notify_presentation_disconnect() -> None:
            await self._broadcast_to_control(json.dumps({"action": "PRESENTATION_DISCONNECTED", "data": {}}))

        async def sse_presentation(request: web.Request) -> web.StreamResponse:
            return await self._sse_endpoint(
                request,
                self.presentation_clients,
                self.pending_to_presentation,
                on_disconnect=notify_presentation_disconnect,
            )

        self.app.router.add_post("/api/cmd", post_cmd)
        self.app.router.add_post("/api/presentation", post_presentation)
        self.app.router.add_get("/api/events", sse_control)
        self.app.router.add_get("/api/presentation/events", sse_presentation)

    async def _broadcast_to_control(self, message: str) -> None:
        queues = list(self.control_clients)
        if not queues:
            self.pending_to_control.append(message)
        for queue in queues:
            await queue.put(message)

    async def _broadcast_to_presentation(self, message: str) -> None:
        queues = list(self.presentation_clients)
        if not queues:
            self.pending_to_presentation.append(message)
        for queue in queues:
            await queue.put(message)

    async def _sse_endpoint(
        self,
        request,
        queues: List[asyncio.Queue],
        pending: List[str],
        *,
        on_disconnect: Optional[Callable[[], Awaitable[None]]] = None,
    ):
        from aiohttp import web

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
                await response.write(f"data: {message}\n\n".encode("utf-8"))
        except asyncio.CancelledError:
            pass
        finally:
            queues.remove(queue)
            try:
                await response.write_eof()
            except ConnectionResetError:
                pass
            if on_disconnect and not self.stop_event.is_set() and not queues:
                await on_disconnect()
        return response

    def start(self) -> None:
        from aiohttp import web

        if self.thread:
            return

        def runner() -> None:
            asyncio.set_event_loop(self.loop)
            self.runner = web.AppRunner(self.app)
            self.loop.run_until_complete(self.runner.setup())
            self.site = web.TCPSite(self.runner, self.host, self.port)
            self.loop.run_until_complete(self.site.start())
            logging.info("HTTP bridge listening on http://%s:%d", self.host, self.port)
            self.ready_event.set()
            try:
                self.loop.run_forever()
            finally:
                self.loop.run_until_complete(self._shutdown())

        self.thread = threading.Thread(target=runner, name="HTTPBridgeServer", daemon=True)
        self.thread.start()
        self.ready_event.wait()

    async def _shutdown(self) -> None:
        if self.site:
            await self.site.stop()
        if self.runner:
            await self.runner.cleanup()

    def stop(self) -> None:
        self.stop_event.set()
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def send_to_control(self, payload: Dict) -> None:
        message = json.dumps(payload)

        async def _send() -> None:
            await self._broadcast_to_control(message)

        self.loop.call_soon_threadsafe(asyncio.create_task, _send())

    def send_to_presentation(self, payload: Dict) -> None:
        message = json.dumps(payload)

        async def _send() -> None:
            await self._broadcast_to_presentation(message)

        self.loop.call_soon_threadsafe(asyncio.create_task, _send())


class PresenterApp:
    def __init__(self, bridge: str, port: int, debug: bool = False) -> None:
        self.bridge_mode = bridge
        self.port = port
        self.debug = debug
        self.server: BridgeServerBase
        if bridge == BRIDGE_WS:
            self.server = WebSocketBridgeServer("127.0.0.1", port, debug=debug)
        else:
            self.server = HttpBridgeServer("127.0.0.1", port, debug=debug)
        self.window: Optional[webview.Window] = None

    def run(self) -> None:
        try:
            self.server.start()
        except RuntimeError as exc:
            logging.error("Failed to start bridge server: %s", exc)
            sys.exit(1)
        base_dir = Path(__file__).resolve().parent.parent
        index_path = base_dir / "web" / "index.html"
        resolved_index = index_path.resolve()
        index_exists = resolved_index.exists()
        backend = select_webview_gui()
        if self.debug:
            logging.debug("Bridge mode: %s", self.bridge_mode)
            logging.debug("Webview backend: %s", backend or "default")
            logging.debug("index.html resolved path: %s", resolved_index)

        window_kwargs = {
            "width": 1600,
            "height": 900,
            "resizable": True,
            "confirm_close": True,
            "allow_local_files_access": True,
        }

        if not index_exists:
            self.server.stop()
            raise FileNotFoundError(f"Presentation HTML not found at {resolved_index}")

        version_token = os.environ.get("PRESENTATION_INDEX_VERSION") or str(int(time.time()))
        query_params = [
            f"mode={self.bridge_mode}",
            f"port={self.port}",
            f"v={version_token}",
        ]
        index_uri = resolved_index.as_uri() + "?" + "&".join(query_params)
        if self.debug:
            logging.debug("index.html URI: %s", index_uri)

        file_uri = index_uri.split("?", 1)[0]
        if file_uri.startswith("file:///"):
            path_fragment = unquote(file_uri[8:])
            if os.name != "nt" and not path_fragment.startswith("/"):
                path_fragment = "/" + path_fragment
            index_file_path = Path(path_fragment)
        else:
            index_file_path = resolved_index

        if not index_file_path.exists():
            self.server.stop()
            raise FileNotFoundError(f"Presentation HTML not found at {index_file_path}")

        logging.info("Loading presentation HTML: %s", index_uri)
        self.window = webview.create_window(
            "Quiz Presentation",
            url=index_uri,
            **window_kwargs,
        )

        def on_closed() -> None:
            logging.info("Presentation window closed.")
            self.server.send_to_control({"action": "FINISHED", "data": {}})
            self.server.stop()

        self.window.events.closed += on_closed

        def on_loaded() -> None:
            logging.info("Presentation HTML load requested (check DevTools if blank)")
            self.server.send_to_control({"action": "READY", "data": {}})

        self.window.events.loaded += on_loaded

        webview.start(gui=backend, debug=self.debug)

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
    logging.basicConfig(level=logging.DEBUG if args.debug or os.environ.get("DEBUG") == "1" else logging.INFO)
    app = PresenterApp(args.bridge, args.port, debug=args.debug)
    try:
        app.run()
    finally:
        app.stop()


if __name__ == "__main__":
    main()
