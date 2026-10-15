"""rbw backend and private one-shot transport. Never log subprocess output."""

import ipaddress
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import stat
import struct
import subprocess
import tempfile
import time
from urllib.parse import quote, urlsplit
import uuid

MAX_PAYLOAD = 65536
MODES = {"login", "username", "password", "totp"}


def public_suffix(name):
    library = ctypes.util.find_library("psl")
    if not library:
        return True  # Fail closed if public-suffix validation is unavailable.
    psl = ctypes.CDLL(library)
    psl.psl_builtin.restype = ctypes.c_void_p
    psl.psl_is_public_suffix2.argtypes = (ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int)
    return bool(psl.psl_is_public_suffix2(psl.psl_builtin(), name.encode("ascii"), 3))


class Failure(Exception):
    def __init__(self, code=1):
        super().__init__("rbw operation failed")
        self.code = code


def private_directory(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise Failure()


def peer(connection, pid):
    actual, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return actual == pid and uid == os.getuid()


def run_rbw(*arguments):
    # Override inherited debug/trace settings; an already-running agent has its own environment.
    result = subprocess.run(["rbw", *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env={**os.environ, "RUST_LOG": "off"}, timeout=240, check=False)
    if result.returncode:
        raise Failure()
    return result.stdout


def host_port(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise Failure(4)
    host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    try:
        ip = ipaddress.ip_address(host)
        host = f"[{ip.compressed}]" if ip.version == 6 else ip.compressed
    except ValueError:
        pass
    port = parsed.port
    if port == {"http": 80, "https": 443}[parsed.scheme]:
        port = None
    return parsed, host + (f":{port}" if port else "")


def uri_matches(rule, target):
    """Conservative rbw URI rules; unsupported regexes never authorize a fill."""
    if not isinstance(rule, dict) or not isinstance(rule.get("uri"), str):
        return False
    kind = rule.get("match_type")
    kind = 0 if kind is None else kind
    if type(kind) is not int or kind not in range(6) or kind in {4, 5}:
        return False
    uri = rule["uri"]
    parsed, host = host_port(target)
    if kind == 3:
        # rbw tolerates a missing trailing slash only at the URL root.
        return target.rstrip("/") == uri.rstrip("/") if parsed.path in {"", "/"} else target == uri
    if kind == 2:
        # Require the same origin as well as the prefix, unlike an unsafe lexical host prefix.
        try:
            other, other_host = host_port(uri)
        except (Failure, ValueError, UnicodeError):
            return False
        return other.scheme == parsed.scheme and other_host == host and target.startswith(uri)
    try:
        other, other_host = host_port(uri)
        if other.scheme != parsed.scheme:
            return False
    except (Failure, ValueError, UnicodeError):
        # rbw also supports bare hostnames; no paths/userinfo or unusual URI schemes.
        if any(char in uri for char in "/@?#") or "://" in uri:
            return False
        try:
            _, other_host = host_port(f"{parsed.scheme}://{uri}")
        except (Failure, ValueError, UnicodeError):
            return False
    if host == other_host:
        return True
    if kind != 0:
        return False
    # Do not treat IP addresses or a single public suffix label as a domain suffix.
    other_name = other_host.split(":", 1)[0]
    try:
        ipaddress.ip_address(other_name.strip("[]"))
        return False
    except ValueError:
        return "." in other_name and not public_suffix(other_name) and host.endswith("." + other_host)


def suggestions(entries, target):
    if not isinstance(entries, list):
        raise Failure()
    result = []
    seen = set()
    for item in entries:
        if not isinstance(item, dict) or item.get("type") != "Login":
            continue
        try:
            item_id = str(uuid.UUID(item["id"]))
        except (KeyError, ValueError, TypeError, AttributeError):
            continue
        uris = item.get("uris")
        if item_id in seen or not isinstance(uris, list):
            continue
        # Include scheme-compatible exact hosts and subdomains as suggestions only.
        if not any(uri_matches({"uri": uri}, target) for uri in uris if isinstance(uri, str)):
            continue
        seen.add(item_id)
        label = lambda value: " ".join(value.split())[:300] if isinstance(value, str) else ""
        result.append({"title": label(item.get("name")) or "Unnamed login",
                       "subtitle": label(item.get("user")), "result": item_id,
                       "search": " ".join(label(item.get(field)) for field in ("name", "user", "folder"))})
    return result


def check_reprompt(item_id):
    """Read only the encrypted cache's policy flag: rbw's public get output omits it.

    Unknown schema or missing policy fails closed. Never decrypt/cache credentials here.
    This layout is intentionally a compatibility gate, not an undocumented agent API.
    """
    config = json.loads(run_rbw("config", "show"))
    profile = os.environ.get("RBW_PROFILE", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]*", profile):
        raise Failure(5)
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / (f"rbw-{profile}" if profile else "rbw")
    private_directory(root)
    email = config.get("email")
    server = config.get("base_url") or "default"
    if not isinstance(email, str) or any(char in email for char in "/\0") or not isinstance(server, str):
        raise Failure(5)
    # Mirrors rbw's INVALID_PATH percent-encoding set, including controls and ':'.
    server = "".join(quote(char, safe="") if ord(char) < 32 or ord(char) == 127 or char in "/%:" else char for char in server)
    path = root / f"{server}:{email}.json"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 64 * 1024 * 1024:
            raise Failure(5)
        data = json.load(stream)
    matches = [entry for entry in data.get("entries", []) if isinstance(entry, dict) and entry.get("id") == item_id]
    if len(matches) != 1 or type(matches[0].get("master_password_reprompt")) is not int or matches[0]["master_password_reprompt"] != 0:
        raise Failure(5)


def credentials(item_id, target, mode):
    check_reprompt(item_id)
    entry = json.loads(run_rbw("get", "--raw", item_id))
    check_reprompt(item_id)  # Reject policy changes made while the selected entry was fetched.
    data = entry.get("data") if isinstance(entry, dict) else None
    if entry.get("id") != item_id or not isinstance(data, dict) or "password" not in data or "uris" not in data:
        raise Failure()
    uris = data.get("uris")
    if not isinstance(uris, list) or not any(uri_matches(rule, target) for rule in uris):
        raise Failure(4)
    fields = ("username", "password") if mode == "login" else (mode,)
    result = {"version": 1, "mode": mode}
    for field in fields:
        value = run_rbw("code", item_id).decode("utf-8").removesuffix("\n") if field == "totp" else data.get(field)
        if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 16000 or any(char in value for char in "\0\r\n"):
            raise Failure()
        if field == "totp" and not re.fullmatch(r"[0-9]{6,10}", value):
            raise Failure()
        result[field] = value
    return result


def select_entry(items, target):
    if not items:
        raise Failure(2)
    picker = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "quickshell/src/services/launcher/launcher.sh"
    # Metadata only; the existing bridge requires a JSON request file.
    with tempfile.TemporaryDirectory(prefix="rbw-menu.", dir=os.environ["QUTERBW_DIRECTORY"]) as directory:
        request = Path(directory) / "request.json"
        request.write_text(json.dumps({"prompt": "Fill login on " + host_port(target)[1], "showPrompt": True, "private": True, "movePointer": False,
                                       "acceptLabel": "Fill", "allowTyped": False, "items": items}), encoding="utf-8")
        process = subprocess.run([str(picker), "--json", str(request)], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=240)
    if process.returncode == 1:
        raise Failure(3)
    if process.returncode:
        raise Failure(8)
    selected = process.stdout.decode("utf-8").strip()
    if selected not in {item["result"] for item in items}:
        raise Failure(8)
    return selected


def serve(payload):
    directory = os.environ["QUTERBW_DIRECTORY"]
    private_directory(directory)
    handle = os.environ["QUTERBW_HANDLE"]
    pid = int(os.environ["QUTERBW_BROWSER_PID"])
    if not re.fullmatch(r"[0-9a-f]{32}", handle):
        raise Failure()
    data = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    if len(data) > MAX_PAYLOAD:
        raise Failure()
    endpoint = str(Path(directory) / "reply")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(endpoint)
            os.chmod(endpoint, 0o600)
            server.listen(1)
            server.settimeout(30)
            with open(os.environ["QUTE_FIFO"], "w", encoding="ascii") as fifo:
                fifo.write(f"rbw-fill-once {handle}\n")
            deadline = time.monotonic() + 30
            while True:
                server.settimeout(max(0.01, deadline - time.monotonic()))
                connection, _ = server.accept()
                with connection:
                    if not peer(connection, pid):
                        if time.monotonic() >= deadline:
                            raise Failure()
                        continue
                    connection.settimeout(10)
                    connection.sendall(struct.pack("!I", len(data)) + data)
                    if connection.recv(1) != b"1":
                        raise Failure(3)
                    return
    finally:
        Path(endpoint).unlink(missing_ok=True)


def main():
    try:
        # Own a process group so browser cancellation also stops launcher/CLI children.
        os.setsid()
        os.umask(0o077)
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(Failure(3)))
        signal.signal(signal.SIGHUP, lambda *_: (_ for _ in ()).throw(Failure(3)))
        # Hard bound also covers malicious/blocked subprocess output and prompts.
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Failure()))
        signal.alarm(300)
        mode = os.environ["QUTERBW_MODE"]
        target = os.environ["QUTE_URL"]
        if mode not in MODES:
            raise Failure()
        if not shutil.which("rbw"):
            raise Failure(6)
        if not re.fullmatch(rb"rbw 1\.15\.[0-9]+\n?", run_rbw("--version")):
            raise Failure(7)
        host_port(target)
        entries = json.loads(run_rbw("list", "--raw"))
        selected = select_entry(suggestions(entries, target), target)
        serve(credentials(selected, target, mode))
        return 0
    except Failure as error:
        return error.code
    except Exception:
        # Do not print errors: Unicode/JSON/subprocess exceptions can contain secrets.
        return 1
    finally:
        signal.alarm(0)
        if os.getpgrp() == os.getpid():
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.killpg(os.getpid(), signal.SIGTERM)
