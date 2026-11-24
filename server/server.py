"""
Smart Environmental Monitoring Station - laptop server.

Reads the Arduino over USB serial and serves a live web dashboard.

    python server.py               # auto-detect the Arduino
    python server.py --port COM5   # pick the port yourself
    python server.py --demo        # no Arduino needed, fake data

Then open http://localhost:8000 (phones on the same Wi-Fi can use the
"Network" address that is printed at start-up).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import mimetypes
import os
import queue
import random
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:
    import serial  # pyserial
    import serial.tools.list_ports
except ImportError:  # demo mode still works without pyserial
    serial = None

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
LOG_DIR = BASE_DIR / "logs"
CONFIG_FILE = BASE_DIR / "config.json"

HISTORY_SIZE = 3600          # readings kept in memory (~2 h at one every 2 s)
ALERT_LOG_SIZE = 100
STALE_AFTER_S = 8            # no data for this long -> dashboard shows "stale"
TEMP_HYST = 0.5              # °C below the limit before an alert clears
HUM_HYST = 2.0               # % below the limit before an alert clears

DEFAULT_CONFIG = {"temp_limit": 35.0, "hum_limit": 80.0, "muted": False}


# --------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------
class Hub:
    """Holds the latest data and pushes events to every open browser tab."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.history: deque[dict] = deque(maxlen=HISTORY_SIZE)
        self.alerts: deque[dict] = deque(maxlen=ALERT_LOG_SIZE)
        self.subscribers: list[queue.Queue] = []
        self.config = self._load_config()
        self.connection = {"state": "starting", "port": None, "mode": "serial", "detail": ""}
        self.arduino_limits: dict | None = None
        self.started_at = time.time()
        self.last_status = "NORMAL"
        self.sensor_error = False
        self.outbox: queue.Queue[str] = queue.Queue()   # commands for the Arduino
        self.stats = self._empty_stats()

    # ----- config -----
    def _load_config(self) -> dict:
        cfg = dict(DEFAULT_CONFIG)
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text()))
        except (FileNotFoundError, ValueError):
            pass
        return cfg

    def _save_config(self) -> None:
        try:
            CONFIG_FILE.write_text(json.dumps(self.config, indent=2))
        except OSError as exc:
            print(f"[config] could not save: {exc}")

    def set_limits(self, temp_limit: float, hum_limit: float) -> dict:
        with self.lock:
            self.config["temp_limit"] = round(temp_limit, 1)
            self.config["hum_limit"] = round(hum_limit, 1)
            self._save_config()
            cfg = dict(self.config)
        self.send_to_arduino(f"LIMITS,{cfg['temp_limit']:.1f},{cfg['hum_limit']:.1f}")
        self.publish("config", cfg)
        return cfg

    def set_muted(self, muted: bool) -> dict:
        with self.lock:
            self.config["muted"] = bool(muted)
            self._save_config()
            cfg = dict(self.config)
        self.send_to_arduino(f"MUTE,{1 if muted else 0}")
        self.publish("config", cfg)
        return cfg

    def sync_arduino(self) -> None:
        """Push the saved limits/mute to a freshly connected Arduino."""
        with self.lock:
            cfg = dict(self.config)
        self.send_to_arduino(f"LIMITS,{cfg['temp_limit']:.1f},{cfg['hum_limit']:.1f}")
        self.send_to_arduino(f"MUTE,{1 if cfg['muted'] else 0}")

    def send_to_arduino(self, line: str) -> None:
        self.outbox.put(line)

    # ----- connection -----
    def set_connection(self, state: str, port: str | None = None, detail: str = "", mode: str | None = None) -> None:
        with self.lock:
            changed = (self.connection["state"], self.connection["port"]) != (state, port)
            self.connection.update(state=state, port=port, detail=detail)
            if mode:
                self.connection["mode"] = mode
            conn = dict(self.connection)
        if changed:
            print(f"[serial] {state}{' on ' + port if port else ''}{' - ' + detail if detail else ''}")
        self.publish("connection", conn)

    # ----- readings -----
    @staticmethod
    def _empty_stats() -> dict:
        return {k: {"min": None, "max": None, "sum": 0.0, "n": 0} for k in ("temp", "hum", "light")}

    def _update_stats(self, reading: dict) -> None:
        for key in ("temp", "hum", "light"):
            s = self.stats[key]
            v = reading[key]
            s["min"] = v if s["min"] is None else min(s["min"], v)
            s["max"] = v if s["max"] is None else max(s["max"], v)
            s["sum"] += v
            s["n"] += 1

    def stats_summary(self) -> dict:
        out = {}
        for key, s in self.stats.items():
            out[key] = {
                "min": s["min"],
                "max": s["max"],
                "avg": round(s["sum"] / s["n"], 1) if s["n"] else None,
            }
        return out

    def add_reading(self, temp: float, hum: float, light_raw: int, arduino_status: str | None) -> None:
        now = time.time()
        with self.lock:
            tl, hl = self.config["temp_limit"], self.config["hum_limit"]
            # Hysteresis: once an alert is on, it only clears when the value
            # drops a little below the limit, so sensor jitter can't flicker it.
            was_t = self.last_status in ("HIGH_TEMP", "HIGH_TEMP_HUM")
            was_h = self.last_status in ("HIGH_HUM", "HIGH_TEMP_HUM")
            high_t = temp > (tl - TEMP_HYST if was_t else tl)
            high_h = hum > (hl - HUM_HYST if was_h else hl)
            if high_t and high_h:
                status = "HIGH_TEMP_HUM"
            elif high_t:
                status = "HIGH_TEMP"
            elif high_h:
                status = "HIGH_HUM"
            else:
                status = "NORMAL"
            reading = {
                "t": round(now, 3),
                "temp": round(temp, 1),
                "hum": round(hum, 1),
                "light_raw": int(light_raw),
                "light": round(light_raw / 1023 * 100, 1),
                "status": status,
                "arduino_status": arduino_status,
            }
            self.history.append(reading)
            self._update_stats(reading)
            self.sensor_error = False
            previous = self.last_status
            self.last_status = status

        log_reading(reading)
        self.publish("reading", reading)

        if status != previous:
            self._log_alert(status, previous, reading)

    def _log_alert(self, status: str, previous: str, reading: dict) -> None:
        if status == "NORMAL":
            msg = "Back to normal"
            level = "ok"
        else:
            parts = []
            if status in ("HIGH_TEMP", "HIGH_TEMP_HUM"):
                parts.append(f"temperature {reading['temp']}°C > {self.config['temp_limit']}°C")
            if status in ("HIGH_HUM", "HIGH_TEMP_HUM"):
                parts.append(f"humidity {reading['hum']}% > {self.config['hum_limit']}%")
            msg = "High " + " and ".join(parts)
            level = "alert"
        entry = {"t": reading["t"], "status": status, "previous": previous, "level": level, "message": msg}
        with self.lock:
            self.alerts.append(entry)
        print(f"[alert] {msg}")
        self.publish("alert", entry)

    def sensor_failed(self) -> None:
        with self.lock:
            first = not self.sensor_error
            self.sensor_error = True
        if first:
            entry = {"t": time.time(), "status": "SENSOR_ERROR", "previous": self.last_status,
                     "level": "warn", "message": "DHT11 not responding - check the D2 wire"}
            with self.lock:
                self.alerts.append(entry)
            self.publish("alert", entry)
        self.publish("sensor_error", {"t": time.time()})

    def set_arduino_limits(self, t: float, h: float) -> None:
        with self.lock:
            self.arduino_limits = {"temp_limit": t, "hum_limit": h}
        self.publish("arduino_limits", self.arduino_limits)

    def clear_history(self) -> None:
        with self.lock:
            self.history.clear()
            self.alerts.clear()
            self.stats = self._empty_stats()
            self.started_at = time.time()
        self.publish("cleared", {})

    # ----- snapshot for new browser tabs -----
    def snapshot(self) -> dict:
        with self.lock:
            latest = self.history[-1] if self.history else None
            return {
                "latest": latest,
                "connection": dict(self.connection),
                "config": dict(self.config),
                "arduino_limits": self.arduino_limits,
                "alerts": list(self.alerts),
                "stats": self.stats_summary(),
                "started_at": self.started_at,
                "server_time": time.time(),
                "stale_after": STALE_AFTER_S,
                "sensor_error": self.sensor_error,
                "count": len(self.history),
            }

    def history_since(self, seconds: float | None) -> list[dict]:
        with self.lock:
            items = list(self.history)
        if seconds:
            cutoff = time.time() - seconds
            items = [r for r in items if r["t"] >= cutoff]
        return items

    # ----- server-sent events -----
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def publish(self, event: str, data) -> None:
        if event == "reading":
            data = {**data, "stats": self.stats_summary()}
        msg = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


HUB = Hub()


# --------------------------------------------------------------------------
# CSV logging (one file per day in server/logs)
# --------------------------------------------------------------------------
_log_lock = threading.Lock()


def log_reading(r: dict) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    stamp = datetime.fromtimestamp(r["t"])
    path = LOG_DIR / f"readings-{stamp:%Y-%m-%d}.csv"
    with _log_lock:
        new = not path.exists()
        try:
            with path.open("a", newline="") as f:
                w = csv.writer(f)
                if new:
                    w.writerow(["timestamp", "temperature_c", "humidity_pct", "light_pct", "light_raw", "status"])
                w.writerow([stamp.isoformat(timespec="seconds"), r["temp"], r["hum"], r["light"], r["light_raw"], r["status"]])
        except OSError as exc:
            print(f"[log] could not write: {exc}")


# --------------------------------------------------------------------------
# Arduino serial reader
# --------------------------------------------------------------------------
# USB vendor IDs used by Arduino boards and the USB chips on clones
ARDUINO_VIDS = {
    0x2341: "Arduino",
    0x2A03: "Arduino.org",
    0x1A86: "CH340 (clone)",
    0x0403: "FTDI",
    0x10C4: "CP210x",
}
ARDUINO_HINTS = ("arduino", "ch340", "ch341")


def find_arduino_port() -> str | None:
    ports = list(serial.tools.list_ports.comports())
    # Exact USB chip IDs first, then the name - never a generic "USB Serial
    # Device", which could be some other gadget plugged into the laptop.
    for p in ports:
        if p.vid in ARDUINO_VIDS:
            return p.device
    for p in ports:
        text = f"{p.description} {p.manufacturer or ''}".lower()
        if any(h in text for h in ARDUINO_HINTS):
            return p.device
    return None


def port_summary() -> str:
    ports = [p.device for p in serial.tools.list_ports.comports()]
    if not ports:
        return "Plug the Arduino into a USB port"
    return f"Plug in the Arduino (ports seen: {', '.join(ports)} - if one is the Arduino, start with --port COMx)"


def parse_line(line: str) -> None:
    parts = [p.strip() for p in line.split(",")]
    if not parts or not parts[0]:
        return
    kind = parts[0].upper()
    try:
        if kind == "DATA" and len(parts) >= 4:
            status = parts[4].upper() if len(parts) >= 5 else None
            HUB.add_reading(float(parts[1]), float(parts[2]), int(float(parts[3])), status)
        elif kind == "LIMITS" and len(parts) >= 3:
            HUB.set_arduino_limits(float(parts[1]), float(parts[2]))
        elif kind == "ERR":
            HUB.sensor_failed()
        elif kind in ("HELLO", "MUTE"):
            pass
        elif len(parts) >= 3:
            # Also accept the simple sketch format: temp,hum,light[,status]
            status = parts[3].upper() if len(parts) >= 4 else None
            HUB.add_reading(float(parts[0]), float(parts[1]), int(float(parts[2])), status)
    except ValueError:
        pass  # half-received line at start-up, ignore


def serial_worker(port_arg: str | None, baud: int, stop: threading.Event) -> None:
    if serial is None:
        HUB.set_connection("error", detail="pyserial is not installed - run: pip install pyserial")
        return

    while not stop.is_set():
        port = port_arg or find_arduino_port()
        if not port:
            HUB.set_connection("searching", detail=port_summary())
            stop.wait(2)
            continue

        try:
            HUB.set_connection("connecting", port)
            with serial.Serial(port, baud, timeout=0.5) as ser:
                time.sleep(2)  # the Arduino resets when the port opens
                ser.reset_input_buffer()
                HUB.set_connection("connected", port)
                HUB.sync_arduino()
                buf = b""
                while not stop.is_set():
                    # send any queued commands
                    while True:
                        try:
                            cmd = HUB.outbox.get_nowait()
                        except queue.Empty:
                            break
                        ser.write((cmd + "\n").encode())
                    chunk = ser.read(256)
                    if chunk:
                        buf += chunk
                        while b"\n" in buf:
                            raw, buf = buf.split(b"\n", 1)
                            line = raw.decode(errors="ignore").strip()
                            if line:
                                parse_line(line)
        except (serial.SerialException, OSError) as exc:
            msg = str(exc)
            if "PermissionError" in msg or "Access is denied" in msg:
                msg = "Port busy - close the Arduino IDE Serial Monitor"
            HUB.set_connection("disconnected", port, msg)
            stop.wait(2)


# --------------------------------------------------------------------------
# Demo mode (no hardware)
# --------------------------------------------------------------------------
def demo_worker(stop: threading.Event) -> None:
    HUB.set_connection("connected", "DEMO", "Simulated sensor data", mode="demo")
    HUB.set_arduino_limits(HUB.config["temp_limit"], HUB.config["hum_limit"])
    t0 = time.time()
    spike_until = 0.0
    while not stop.is_set():
        # drain commands the dashboard sends and echo them back like the Arduino
        while True:
            try:
                cmd = HUB.outbox.get_nowait()
            except queue.Empty:
                break
            if cmd.startswith("LIMITS,"):
                _, t, h = cmd.split(",")
                HUB.set_arduino_limits(float(t), float(h))

        el = time.time() - t0
        if time.time() > spike_until and random.random() < 0.01:
            spike_until = time.time() + 20        # occasional heat spike to show alerts
        spike = 9.0 if time.time() < spike_until else 0.0
        temp = 28 + 3 * math.sin(el / 60) + random.uniform(-0.3, 0.3) + spike
        hum = 58 + 8 * math.sin(el / 90 + 1) + random.uniform(-1, 1)
        light = 620 + 250 * math.sin(el / 45) + random.uniform(-25, 25)
        HUB.add_reading(temp, hum, int(max(0, min(1023, light))), None)
        stop.wait(2)


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "EnvMonitor/1.0"

    def log_message(self, fmt, *args):  # keep the console readable
        pass

    # ----- helpers -----
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 10_000:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return {}

    # ----- routes -----
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        qs = parse_qs(url.query)

        if path == "/":
            return self._static("index.html")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/state":
            return self._json(HUB.snapshot())
        if path == "/api/history":
            try:
                seconds = float(qs.get("seconds", ["0"])[0]) or None
            except ValueError:
                seconds = None
            return self._json(HUB.history_since(seconds))
        if path == "/api/stream":
            return self._stream()
        if path == "/api/export.csv":
            return self._export_csv()
        if path == "/api/ports":
            if serial is None:
                return self._json([])
            return self._json([{"device": p.device, "description": p.description}
                               for p in serial.tools.list_ports.comports()])
        self._send(404, b"Not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_json()
        if path == "/api/limits":
            try:
                t = float(body["temp_limit"])
                h = float(body["hum_limit"])
            except (KeyError, TypeError, ValueError):
                return self._json({"error": "temp_limit and hum_limit are required numbers"}, 400)
            if not (0 < t < 80) or not (0 < h <= 100):
                return self._json({"error": "temperature 1-79 °C, humidity 1-100 %"}, 400)
            return self._json(HUB.set_limits(t, h))
        if path == "/api/mute":
            return self._json(HUB.set_muted(bool(body.get("muted"))))
        if path == "/api/clear":
            HUB.clear_history()
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def _static(self, rel: str) -> None:
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def _export_csv(self) -> None:
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["timestamp", "temperature_c", "humidity_pct", "light_pct", "light_raw", "status"])
        for r in HUB.history_since(None):
            w.writerow([datetime.fromtimestamp(r["t"]).isoformat(timespec="seconds"),
                        r["temp"], r["hum"], r["light"], r["light_raw"], r["status"]])
        name = f"env-monitor-{datetime.now():%Y%m%d-%H%M}.csv"
        self._send(200, out.getvalue().encode(), "text/csv; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="{name}"'})

    def _stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = HUB.subscribe()
        try:
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = ": keep-alive\n\n"
                self.wfile.write(msg.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            HUB.unsubscribe(q)


def lan_addresses() -> list[str]:
    addrs = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def main() -> None:
    ap = argparse.ArgumentParser(description="Environmental Monitoring Station dashboard server")
    ap.add_argument("--port", help="Serial port, e.g. COM5 (default: auto-detect)")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--demo", action="store_true", help="Run with simulated data, no Arduino needed")
    ap.add_argument("--host", default="0.0.0.0", help="Use 127.0.0.1 to hide it from the network")
    ap.add_argument("--http-port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = ap.parse_args()

    # Old Windows consoles can't print "°" - replace instead of crashing
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    stop = threading.Event()
    if args.demo:
        HUB.connection["mode"] = "demo"
        worker = threading.Thread(target=demo_worker, args=(stop,), daemon=True)
    else:
        worker = threading.Thread(target=serial_worker, args=(args.port, args.baud, stop), daemon=True)
    worker.start()

    ThreadingHTTPServer.daemon_threads = True
    try:
        httpd = ThreadingHTTPServer((args.host, args.http_port), Handler)
    except OSError as exc:
        print(f"Could not start on port {args.http_port}: {exc}\nTry: python server.py --http-port 8080")
        sys.exit(1)

    print("=" * 56)
    print("  Smart Environmental Monitoring Station")
    print("=" * 56)
    print(f"  Mode     : {'DEMO (simulated data)' if args.demo else 'Arduino on ' + (args.port or 'auto-detect')}")
    print(f"  Dashboard: http://localhost:{args.http_port}")
    if args.host == "0.0.0.0":
        for a in lan_addresses():
            print(f"  Network  : http://{a}:{args.http_port}   (phones on same Wi-Fi)")
    print(f"  CSV logs : {LOG_DIR}")
    print("  Press Ctrl+C to stop.")
    print("=" * 56)

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
