import json
import os
import subprocess
import typing
from dataclasses import dataclass

from chroot_distro.constants import CONTAINERS_DIR, PROGRAM_NAME
from chroot_distro.locking import container_busy_status
from chroot_distro.message import C, msg
from chroot_distro.paths import container_manifest, container_rootfs
from chroot_distro.progress import fmt_size, loading_line


@dataclass(frozen=True)
class _ContainerRow:
    name: str
    size: str
    source: str
    status: str


def _iter_container_names() -> list[str]:
    try:
        return sorted(e for e in os.listdir(CONTAINERS_DIR) if os.path.isdir(container_rootfs(e)))
    except OSError:
        return []


def _rootfs_size_bytes(rootfs: str) -> int:
    try:
        out = subprocess.check_output(
            ["du", "-sb", "-x", "--", rootfs],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return int(out.split(maxsplit=1)[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return _rootfs_size_walk(rootfs)


def _rootfs_size_walk(rootfs: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(rootfs, followlinks=False):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            try:
                total += os.path.getsize(path)
            except OSError:
                continue
    return total


def _read_image_source(name: str) -> str:
    manifest_path = container_manifest(name)
    if not os.path.isfile(manifest_path):
        return "local archive"
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            data: dict[str, typing.Any] = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return "unknown"
    image_ref = data.get("image_ref") or ""
    if not image_ref:
        return "local archive"
    arch = data.get("arch") or ""
    if arch:
        return f"{image_ref} ({arch})"
    return str(image_ref)


def _container_row(name: str) -> _ContainerRow:
    rootfs = container_rootfs(name)
    try:
        size = fmt_size(_rootfs_size_bytes(rootfs))
    except OSError:
        size = "?"
    return _ContainerRow(
        name=name,
        size=size,
        source=_read_image_source(name),
        status=container_busy_status(name),
    )


def _format_table(rows: list[_ContainerRow]) -> list[str]:
    name_w = max(len("NAME"), *(len(r.name) for r in rows))
    size_w = max(len("SIZE"), *(len(r.size) for r in rows))
    source_w = max(len("SOURCE"), *(len(r.source) for r in rows))
    status_w = max(len("STATUS"), *(len(r.status) for r in rows))

    lines = [
        f"  {C['BCYAN']}{'NAME':<{name_w}}  {'SIZE':>{size_w}}  {'SOURCE':<{source_w}}  {'STATUS':<{status_w}}{C['RST']}",
    ]
    for row in rows:
        status_color = "YELLOW" if row.status.startswith("in use") else "GREEN"
        lines.append(
            f"  {C['GREEN']}{row.name:<{name_w}}{C['RST']}  "
            f"{C['CYAN']}{row.size:>{size_w}}{C['RST']}  "
            f"{row.source:<{source_w}}  "
            f"{C[status_color]}{row.status:<{status_w}}{C['RST']}"
        )
    return lines


def command_list(args) -> None:
    """List every container directory that contains a rootfs/."""
    quiet = getattr(args, "quiet", False)
    entries = _iter_container_names()

    if quiet:
        for name in entries:
            print(name)
        return

    msg()
    if not entries:
        msg(f"{C['YELLOW']}No containers are installed.{C['RST']}")
        msg()
        msg(f"{C['CYAN']}Install one with: {C['GREEN']}{PROGRAM_NAME} install ubuntu:25.10{C['RST']}")
    else:
        rows: list[_ContainerRow] = []
        total = len(entries)
        with loading_line("Gathering container info...") as update:
            for index, name in enumerate(entries, start=1):
                update(f"Scanning {name} ({index}/{total})...")
                rows.append(_container_row(name))
        msg(f"{C['CYAN']}Installed containers:{C['RST']}")
        msg()
        for line in _format_table(rows):
            msg(line)
        msg()
        msg(f"{C['CYAN']}Log in with: {C['GREEN']}{PROGRAM_NAME} login <name>{C['RST']}")
    msg()
