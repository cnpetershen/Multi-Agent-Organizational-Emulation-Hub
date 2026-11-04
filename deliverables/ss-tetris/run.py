#!/usr/bin/env python3
"""Run 开发一个俄罗斯方块程序 locally — one command, no arguments.

    python run.py

The delivery has two halves and this script starts them in the right order:

* with a backend (`server/app.py` or `server/server.mjs`) it starts the service, which also
  serves the client, and opens a browser on it;
* without one it serves `client/` as plain static files.

Nothing else is required: there is no dependency file and no build step.
"""
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))
URL = "http://127.0.0.1:%d/" % PORT


def serve_static() -> None:
    def handler(*args, **kwargs):
        return SimpleHTTPRequestHandler(*args, directory=str(ROOT / "client"), **kwargs)

    print("no backend in this delivery - serving the client on %s" % URL)
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()


def main() -> None:
    python_service = ROOT / "server" / "app.py"
    node_service = ROOT / "server" / "server.mjs"
    if python_service.is_file():
        command = [sys.executable, str(python_service)]
    elif node_service.is_file():
        command = ["node", str(node_service)]
    else:
        serve_static()
        return
    print("starting: %s" % " ".join(command))
    process = subprocess.Popen(command)
    threading.Timer(1.5, lambda: webbrowser.open(URL)).start()
    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()


if __name__ == "__main__":
    main()
