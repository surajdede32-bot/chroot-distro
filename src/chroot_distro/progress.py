import contextlib
import itertools
import sys
import threading
import typing

from chroot_distro.message import C, is_quiet, tty_safe_for_writes

REDRAW_THRESHOLD_BYTES = 262144


def fmt_size(n_bytes: int) -> str:
    """Return a human-readable size string (B, KiB, MiB, GiB)."""
    if n_bytes >= 1 << 30:
        return f"{n_bytes / (1 << 30):.1f} GiB"
    if n_bytes >= 1 << 20:
        return f"{n_bytes / (1 << 20):.1f} MiB"
    if n_bytes >= 1 << 10:
        return f"{n_bytes / (1 << 10):.1f} KiB"
    return f"{n_bytes} B"


class ByteCounter:
    """File wrapper that tallies bytes flowing through read()/readinto()."""

    def __init__(self, fh):
        self._fh = fh
        self.count = 0

    def read(self, size=-1):
        data = self._fh.read(size)
        self.count += len(data)
        return data

    def readinto(self, buf):
        n = self._fh.readinto(buf)
        self.count += n
        return n

    def __getattr__(self, name):
        return getattr(self._fh, name)


def progress_active() -> bool:
    """Return True when progress output should be written to stderr."""
    return sys.stderr.isatty() and not is_quiet()


def draw_bytes_bar(
    done: int,
    total: int = 0,
    *,
    label: str = "",
    noun: str = "processed",
) -> None:
    """Draw a [####----] progress line keyed by byte counts."""
    if not progress_active() or not tty_safe_for_writes():
        return
    pfx = f"{C['BLUE']}[{C['GREEN']}*{C['BLUE']}] {C['CYAN']}"
    head = f"{label}: " if label else ""
    if total:
        pct = min(done * 100 // total, 100)
        bar = "#" * (pct // 5) + "-" * (20 - pct // 5)
        line = f"\r{pfx}{head}[{bar}] {pct:3d}%  {fmt_size(done)} / {fmt_size(total)}\033[K{C['RST']}"
    else:
        line = f"\r{pfx}{head}{fmt_size(done)} {noun}...\033[K{C['RST']}"
    sys.stderr.write(line)
    sys.stderr.flush()


def draw_count_bar(
    done: int,
    total: int,
    *,
    label: str = "",
    unit: str = "files",
) -> None:
    """Draw a [####----] progress line keyed by item count rather than bytes."""
    if not progress_active() or not tty_safe_for_writes():
        return
    pfx = f"{C['BLUE']}[{C['GREEN']}*{C['BLUE']}] {C['CYAN']}"
    head = f"{label}: " if label else ""
    pct = (done * 100 // total) if total else 100
    bar = "#" * (pct // 5) + "-" * (20 - pct // 5)
    line = f"\r{pfx}{head}[{bar}] {pct:3d}%  {done} / {total} {unit}\033[K{C['RST']}"
    sys.stderr.write(line)
    sys.stderr.flush()


def clear_bar() -> None:
    """Erase the current progress line. No-op when output is inactive."""
    if not progress_active() or not tty_safe_for_writes():
        return
    sys.stderr.write("\r\033[K")
    sys.stderr.flush()


@contextlib.contextmanager
def loading_line(
    initial: str = "Loading...",
) -> typing.Iterator[typing.Callable[[str], None]]:
    """Show an animated status line on stderr until the context exits.

    Yields an ``update(text)`` callable to change the message (for example
    per-container progress during ``list``).
    """
    if not progress_active() or not tty_safe_for_writes():

        def _noop(_text: str) -> None:
            return

        yield _noop
        return

    state = {"text": initial}
    stop = threading.Event()
    pfx = f"{C['BLUE']}[{C['GREEN']}*{C['BLUE']}] {C['CYAN']}"

    def _spin() -> None:
        for frame in itertools.cycle("|/-\\"):
            if stop.wait(0.08):
                break
            line = f"\r{pfx}{frame} {state['text']}\033[K{C['RST']}"
            sys.stderr.write(line)
            sys.stderr.flush()

    thread = threading.Thread(target=_spin, daemon=True)
    thread.start()

    def update(text: str) -> None:
        state["text"] = text

    try:
        yield update
    finally:
        stop.set()
        thread.join(timeout=1.0)
        clear_bar()


class AggregateByteProgress:
    """Thread-safe byte counter that drives one shared progress bar."""

    def __init__(self, total: int = 0, *, label: str = "") -> None:
        self._lock = threading.Lock()
        self._done = 0
        self._total = total
        self._label = label
        self._last_shown = 0

    def add(self, nbytes: int) -> None:
        with self._lock:
            self._done += nbytes
            if self._done == self._total or self._done - self._last_shown >= REDRAW_THRESHOLD_BYTES:
                self._last_shown = self._done
                draw_bytes_bar(self._done, self._total, label=self._label, noun="downloaded")

    def clear(self) -> None:
        clear_bar()
