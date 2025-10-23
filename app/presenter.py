import argparse
import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

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
        self.loop = asyncio.new_event_loop()
        self.thread: Optional[threading.Thread] = None
        self.server = None
        self.control_conn = None
        self.presentation_conn = None
        self.pending_to_control: List[str] = []
        self.pending_to_presentation: List[str] = []
        self.ready_event = threading.Event()
        self.stop_event = threading.Event()

    def start(self) -> None:
        import websockets

        if self.thread:
            return

        async def handler(websocket, path):  # type: ignore
            if path == "/control":
                await self._handle_control(websocket)
            else:
                await self._handle_presentation(websocket)

        def runner() -> None:
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(websockets.serve(handler, self.host, self.port))
            self.ready_event.set()
            try:
                self.loop.run_forever()
            finally:
                self.loop.run_until_complete(self._close_all())

        self.thread = threading.Thread(target=runner, name="WSBridgeServer", daemon=True)
        self.thread.start()
        self.ready_event.wait()

    async def _close_all(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for conn in [self.control_conn, self.presentation_conn]:
            if conn:
                try:
                    await conn.close()
                except Exception:  # pylint: disable=broad-except
                    pass

    async def _handle_control(self, websocket) -> None:
        import websockets

        self.control_conn = websocket
        await self._flush_pending(self.pending_to_control, websocket)
        try:
            async for message in websocket:
                await self._forward_to_presentation(message)
        except websockets.exceptions.ConnectionClosed:  # type: ignore[attr-defined]
            pass
        finally:
            self.control_conn = None

    async def _handle_presentation(self, websocket) -> None:
        import websockets

        self.presentation_conn = websocket
        await self._flush_pending(self.pending_to_presentation, websocket)
        try:
            async for message in websocket:
                await self._forward_to_control(message)
        except websockets.exceptions.ConnectionClosed:  # type: ignore[attr-defined]
            pass
        finally:
            self.presentation_conn = None

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
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def send_to_control(self, payload: Dict) -> None:
        message = json.dumps(payload)

        async def _send() -> None:
            await self._forward_to_control(message)

        self.loop.call_soon_threadsafe(asyncio.create_task, _send())

    def send_to_presentation(self, payload: Dict) -> None:
        message = json.dumps(payload)

        async def _send() -> None:
            await self._forward_to_presentation(message)

        self.loop.call_soon_threadsafe(asyncio.create_task, _send())


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

        async def sse_presentation(request: web.Request) -> web.StreamResponse:
            return await self._sse_endpoint(request, self.presentation_clients, self.pending_to_presentation)

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

    async def _sse_endpoint(self, request, queues: List[asyncio.Queue], pending: List[str]):
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
        self.server.start()
        base_dir = Path(__file__).resolve().parent.parent
        index_path = base_dir / "web" / "index.html"
        index_uri = index_path.resolve().as_uri() + f"?mode={self.bridge_mode}&port={self.port}"
        backend = select_webview_gui()
        if self.debug:
            logging.debug("Bridge mode: %s", self.bridge_mode)
            logging.debug("Webview backend: %s", backend or "default")
            logging.debug("index.html URI: %s", index_uri)

        self.window = webview.create_window(
            "Quiz Presentation",
            url=index_uri,
            width=1600,
            height=900,
            resizable=True,
            confirm_close=True,
        )

        def on_closed() -> None:
            logging.info("Presentation window closed.")
            self.server.send_to_control({"action": "FINISHED", "data": {}})
            self.server.stop()

        self.window.events.closed += on_closed

        def on_loaded() -> None:
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
