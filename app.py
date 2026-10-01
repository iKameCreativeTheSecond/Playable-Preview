import base64
import io
import json
import secrets
import threading
import uuid

import qrcode
from flask import Flask, Response, abort, render_template, url_for
from flask_sock import Sock

app = Flask(__name__)
sock = Sock(app)

shares_lock = threading.Lock()
shares = {}  # share_id -> {"ws": ..., "pending": {req_id: Event}, "results": {req_id: dict}}

REQUEST_TIMEOUT = 10  # seconds

OFFLINE_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Playable offline</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem;">
<h2>Playable hien khong online</h2>
<p>Nguoi chia se da ngat ket noi hoac dong tab trinh duyet.</p>
</body></html>"""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/qr/<share_id>")
def share_qr(share_id):
    url = url_for("serve_shared", share_id=share_id, _external=True)
    img = qrcode.make(url, box_size=6, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), mimetype="image/png")


@sock.route("/ws/host")
def ws_host(ws):
    share_id = secrets.token_urlsafe(6)
    session = {"ws": ws, "pending": {}, "results": {}}
    with shares_lock:
        shares[share_id] = session

    ws.send(json.dumps({"type": "registered", "share_id": share_id}))

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            msg = json.loads(raw)
            if msg.get("type") == "response":
                req_id = msg.get("id")
                event = session["pending"].get(req_id)
                if event:
                    session["results"][req_id] = msg
                    event.set()
    except Exception:
        pass
    finally:
        with shares_lock:
            shares.pop(share_id, None)
        for event in session["pending"].values():
            event.set()


def _relay_request(share_id, path):
    with shares_lock:
        session = shares.get(share_id)
    if session is None:
        return None

    req_id = uuid.uuid4().hex
    event = threading.Event()
    session["pending"][req_id] = event

    try:
        session["ws"].send(json.dumps({"type": "request", "id": req_id, "path": path}))
    except Exception:
        session["pending"].pop(req_id, None)
        return None

    finished = event.wait(REQUEST_TIMEOUT)
    result = session["results"].pop(req_id, None)
    session["pending"].pop(req_id, None)

    if not finished or result is None:
        return "timeout"
    return result


@app.route("/p/<share_id>/", defaults={"subpath": ""}, methods=["GET"])
@app.route("/p/<share_id>/<path:subpath>", methods=["GET"])
def serve_shared(share_id, subpath):
    if ".." in subpath.split("/"):
        abort(400)

    # Empty path means "root of the share" -- the client resolves which
    # actual file that maps to (it doesn't have to be named index.html).
    result = _relay_request(share_id, subpath)

    if result is None:
        return Response(OFFLINE_HTML, status=404, mimetype="text/html")
    if result == "timeout":
        return Response("Playable khong phan hoi kip thoi.", status=504, mimetype="text/plain")

    status = result.get("status", 200)
    if status == 404:
        return Response(f"Khong tim thay: /{subpath}", status=404, mimetype="text/plain")

    content_type = result.get("contentType") or "application/octet-stream"
    body_b64 = result.get("bodyBase64", "")
    body = base64.b64decode(body_b64) if body_b64 else b""
    return Response(body, status=status, mimetype=content_type)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True, debug=True)
