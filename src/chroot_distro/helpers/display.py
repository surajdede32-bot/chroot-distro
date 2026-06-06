import logging
import os
from dataclasses import dataclass
from enum import Enum

from chroot_distro.constants import TERMUX_PREFIX
from chroot_distro.helpers.x11 import (
    guest_can_read_auth,
    provision_guest_xauthority,
    resolve_host_x11_env,
    resolve_invoking_uid,
    x11_auth_bind_path,
)

log = logging.getLogger(__name__)


class DisplayMode(Enum):
    NONE = "none"
    X11_ONLY = "x11"
    WAYLAND_ONLY = "wayland"
    XWAYLAND_HYBRID = "xwayland"


@dataclass
class DisplayConfig:
    mode: DisplayMode
    binds: list[tuple[str, str]]
    env: dict[str, str]
    x11_auth_binds: list[str]

    def merge_env(self, user_env: dict[str, str]) -> dict[str, str]:
        result = self.env.copy()
        result.update(user_env)
        return result


def _parse_display_num(display: str) -> str:
    """Parse display number from DISPLAY string, e.g. ':1.0' -> '1'."""
    if not display:
        return "1"
    # format: [host]:display[.screen]
    part = display.rsplit(":", maxsplit=1)[-1]
    num = part.split(".")[0]
    return num if num.isdigit() else "1"


class DisplayDetector:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def detect(self) -> tuple[DisplayMode, str, str, str]:
        """Detect display server settings on the host.

        Returns:
            Tuple of (DisplayMode, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR)
            incorporating fallbacks if variables are missing on the host.
        """
        uid = resolve_invoking_uid()

        # 1. Resolve values / apply fallbacks
        host_display = os.environ.get("DISPLAY", "")
        if not host_display:
            display = ":0" if self.is_termux else ":1"
        else:
            display = host_display

        host_wayland = os.environ.get("WAYLAND_DISPLAY", "")
        wayland_display = host_wayland if host_wayland else "wayland-1"

        host_runtime = os.environ.get("XDG_RUNTIME_DIR", "")
        if not host_runtime:
            if self.is_termux:
                xdg_runtime_dir = f"{TERMUX_PREFIX}/tmp"
            else:
                xdg_runtime_dir = f"/run/user/{uid}"
        else:
            xdg_runtime_dir = host_runtime

        # 2. Check socket existence
        wayland_exists = False
        if self.is_termux:
            # Termux: check multiple paths for Wayland socket
            candidates = [
                os.path.join(xdg_runtime_dir, wayland_display),
                os.path.join(f"{TERMUX_PREFIX}/tmp", wayland_display),
                os.path.join("/data/data/com.termux/files/usr/tmp", wayland_display),
            ]
            for path in candidates:
                if os.path.exists(path):
                    wayland_exists = True
                    break
        else:
            # Linux: check runtime dir
            wayland_path = os.path.join(xdg_runtime_dir, wayland_display)
            if os.path.exists(wayland_path):
                wayland_exists = True

        x11_exists = False
        display_num = _parse_display_num(display)
        if self.is_termux:
            x11_path = f"{TERMUX_PREFIX}/tmp/.X11-unix/X{display_num}"
            if os.path.exists(x11_path):
                x11_exists = True
        else:
            x11_path = f"/tmp/.X11-unix/X{display_num}"
            if os.path.exists(x11_path):
                x11_exists = True

        # 3. Determine Mode
        if wayland_exists and x11_exists:
            mode = DisplayMode.XWAYLAND_HYBRID
        elif wayland_exists:
            mode = DisplayMode.WAYLAND_ONLY
        elif x11_exists:
            mode = DisplayMode.X11_ONLY
        else:
            mode = DisplayMode.NONE
            if host_display or host_wayland:
                # Sockets not found, but user has explicit env vars on host; trust them
                if host_wayland and host_display:
                    mode = DisplayMode.XWAYLAND_HYBRID
                elif host_wayland:
                    mode = DisplayMode.WAYLAND_ONLY
                else:
                    mode = DisplayMode.X11_ONLY

        return mode, display, wayland_display, xdg_runtime_dir


class WaylandConfig:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def configure(
        self, wayland_display: str, xdg_runtime_dir: str, guest_uid: int
    ) -> tuple[list[tuple[str, str]], dict[str, str]]:
        binds = []
        env = {}

        # Locate host socket
        host_socket = ""
        if self.is_termux:
            candidates = [
                os.path.join(xdg_runtime_dir, wayland_display),
                os.path.join(f"{TERMUX_PREFIX}/tmp", wayland_display),
                os.path.join("/data/data/com.termux/files/usr/tmp", wayland_display),
            ]
            for path in candidates:
                if os.path.exists(path):
                    host_socket = path
                    break
        else:
            host_socket = os.path.join(xdg_runtime_dir, wayland_display)

        if host_socket and os.path.exists(host_socket):
            # Target path under rootfs
            guest_runtime_dir = f"/run/user/{guest_uid}"
            guest_socket = os.path.join(guest_runtime_dir, wayland_display)
            binds.append((host_socket, guest_socket))
            env["WAYLAND_DISPLAY"] = wayland_display
            env["XDG_RUNTIME_DIR"] = guest_runtime_dir
        else:
            # Sockets not found, forward environment variable only (fallback mode)
            guest_runtime_dir = f"/run/user/{guest_uid}"
            env["WAYLAND_DISPLAY"] = wayland_display
            env["XDG_RUNTIME_DIR"] = guest_runtime_dir

        return binds, env


class X11Config:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def configure(
        self,
        rootfs: str,
        display: str,
        login_user: str,
        guest_uid: int,
        guest_gid: int,
    ) -> tuple[list[tuple[str, str]], dict[str, str], list[str]]:
        binds = []
        env = {}
        auth_binds = []

        if self.is_termux:
            # Termux-X11 socket binding
            host_x11 = f"{TERMUX_PREFIX}/tmp/.X11-unix"
            if os.path.exists(host_x11):
                binds.append((host_x11, "/tmp/.X11-unix"))
            env["DISPLAY"] = display
        else:
            # Regular Linux X11 socket binding
            host_x11 = "/tmp/.X11-unix"
            if os.path.exists(host_x11):
                binds.append((host_x11, "/tmp/.X11-unix"))

            # Reuse x11.py to resolve X11 environment and authority
            x11_env, resolved_x11_binds = resolve_host_x11_env()
            for key, val in x11_env.items():
                env[key] = val

            # Make sure DISPLAY is resolved
            if "DISPLAY" not in env:
                env["DISPLAY"] = display

            auth_binds = list(resolved_x11_binds)
            xauth = env.get("XAUTHORITY", "")
            bind_path = x11_auth_bind_path(xauth)
            if bind_path and bind_path not in auth_binds:
                auth_binds.append(bind_path)

            if xauth and not guest_can_read_auth(guest_uid, xauth):
                guest_xauth = provision_guest_xauthority(
                    rootfs,
                    host_xauthority=xauth,
                    display=env.get("DISPLAY", ""),
                    guest_uid=guest_uid,
                    guest_gid=guest_gid,
                )
                if guest_xauth:
                    env["XAUTHORITY"] = guest_xauth
                    auth_binds = [p for p in auth_binds if os.path.realpath(p) != os.path.realpath(xauth)]

        return binds, env, auth_binds


class GPUConfig:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def configure(self) -> list[tuple[str, str]]:
        if self.is_termux:
            return []

        binds = []
        dri_path = "/dev/dri"
        if os.path.exists(dri_path):
            try:
                devices = os.listdir(dri_path)
                for dev in devices:
                    dev_path = os.path.join(dri_path, dev)
                    if os.access(dev_path, os.R_OK):
                        binds.append((dev_path, dev_path))
                if not binds and devices:
                    log.warning(
                        "DRI devices exist but are not readable. "
                        "Add user to 'video' or 'render' group for GPU acceleration."
                    )
            except OSError as e:
                log.debug("Failed to list DRI devices: %s", e)
        return binds


class AudioConfig:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def configure(self, xdg_runtime_dir: str, guest_uid: int) -> tuple[list[tuple[str, str]], dict[str, str]]:
        if self.is_termux:
            return [], {"PULSE_SERVER": "127.0.0.1"}

        binds = []
        env = {}
        guest_runtime_dir = f"/run/user/{guest_uid}"

        # 1. PulseAudio socket
        pulse_socket = os.path.join(xdg_runtime_dir, "pulse", "native")
        if os.path.exists(pulse_socket):
            guest_pulse = os.path.join(guest_runtime_dir, "pulse", "native")
            binds.append((pulse_socket, guest_pulse))
            env["PULSE_SERVER"] = f"unix:{guest_pulse}"

        # 2. PipeWire socket
        pipewire_socket = os.path.join(xdg_runtime_dir, "pipewire-0")
        if os.path.exists(pipewire_socket):
            guest_pw = os.path.join(guest_runtime_dir, "pipewire-0")
            binds.append((pipewire_socket, guest_pw))
            env["PIPEWIRE_RUNTIME_DIR"] = guest_runtime_dir

        if "PULSE_SERVER" in os.environ and "PULSE_SERVER" not in env:
            env["PULSE_SERVER"] = os.environ["PULSE_SERVER"]

        return binds, env


class DBusConfig:
    def __init__(self, is_termux: bool):
        self.is_termux = is_termux

    def configure(self, xdg_runtime_dir: str, guest_uid: int) -> tuple[list[tuple[str, str]], dict[str, str]]:
        if self.is_termux:
            return [], {}

        binds = []
        env = {}
        guest_runtime_dir = f"/run/user/{guest_uid}"

        # 1. Session bus
        session_bus = os.path.join(xdg_runtime_dir, "bus")
        if os.path.exists(session_bus):
            guest_bus = os.path.join(guest_runtime_dir, "bus")
            binds.append((session_bus, guest_bus))
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={guest_bus}"

        # 2. System bus
        system_bus = "/run/dbus/system_bus_socket"
        if os.path.exists(system_bus):
            binds.append((system_bus, system_bus))

        if "DBUS_SESSION_BUS_ADDRESS" in os.environ and "DBUS_SESSION_BUS_ADDRESS" not in env:
            env["DBUS_SESSION_BUS_ADDRESS"] = os.environ["DBUS_SESSION_BUS_ADDRESS"]

        return binds, env


def configure_display_forwarding(
    rootfs: str,
    *,
    is_termux: bool,
    isolated: bool,
    dist_type: str,
    login_user: str,
    login_uid: int,
    login_gid: int,
) -> DisplayConfig:
    """Detect and construct configuration for display, audio, GPU, and DBus forwarding."""
    detector = DisplayDetector(is_termux=is_termux)
    mode, display, wayland_display, xdg_runtime_dir = detector.detect()

    binds = []
    env = {}
    x11_auth_binds = []

    if mode == DisplayMode.NONE:
        # Warn if requested display support but none detected
        log.warning("No display server detected on host. GUI apps may fail to launch.")

    # 1. Configure Wayland socket if mode has Wayland
    if mode in (DisplayMode.WAYLAND_ONLY, DisplayMode.XWAYLAND_HYBRID):
        wl_cfg = WaylandConfig(is_termux=is_termux)
        wl_binds, wl_env = wl_cfg.configure(wayland_display, xdg_runtime_dir, login_uid)
        binds.extend(wl_binds)
        env.update(wl_env)

    # 2. Configure X11 socket if mode has X11
    if mode in (DisplayMode.X11_ONLY, DisplayMode.XWAYLAND_HYBRID) or (mode == DisplayMode.NONE):
        x11_cfg = X11Config(is_termux=is_termux)
        x11_binds, x11_env, auth_binds = x11_cfg.configure(
            rootfs=rootfs,
            display=display,
            login_user=login_user,
            guest_uid=login_uid,
            guest_gid=login_gid,
        )
        binds.extend(x11_binds)
        env.update(x11_env)
        x11_auth_binds.extend(auth_binds)

    # 3. GPU pass-through
    gpu_cfg = GPUConfig(is_termux=is_termux)
    binds.extend(gpu_cfg.configure())

    # 4. Audio forwarding
    audio_cfg = AudioConfig(is_termux=is_termux)
    audio_binds, audio_env = audio_cfg.configure(xdg_runtime_dir, login_uid)
    binds.extend(audio_binds)
    env.update(audio_env)

    # 5. DBus session & system bus forwarding
    dbus_cfg = DBusConfig(is_termux=is_termux)
    dbus_binds, dbus_env = dbus_cfg.configure(xdg_runtime_dir, login_uid)
    binds.extend(dbus_binds)
    env.update(dbus_env)

    return DisplayConfig(
        mode=mode,
        binds=binds,
        env=env,
        x11_auth_binds=x11_auth_binds,
    )
