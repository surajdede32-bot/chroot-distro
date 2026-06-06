import os
from unittest.mock import patch, MagicMock

from chroot_distro.helpers.display import (
    DisplayMode,
    DisplayDetector,
    WaylandConfig,
    X11Config,
    GPUConfig,
    AudioConfig,
    DBusConfig,
    configure_display_forwarding,
    _parse_display_num,
)

def test_parse_display_num():
    assert _parse_display_num(":1.0") == "1"
    assert _parse_display_num(":0") == "0"
    assert _parse_display_num("unix:10.5") == "10"
    assert _parse_display_num("") == "1"
    assert _parse_display_num("invalid") == "1"

def test_display_detector_none():
    detector = DisplayDetector(is_termux=False)
    with patch.dict(os.environ, {}, clear=True), \
         patch("chroot_distro.helpers.display.resolve_invoking_uid", return_value=1000), \
         patch("os.path.exists", return_value=False):
        mode, display, wayland_display, xdg_runtime_dir = detector.detect()
        assert mode == DisplayMode.NONE
        assert display == ":1"
        assert wayland_display == "wayland-1"
        assert xdg_runtime_dir == "/run/user/1000"

def test_display_detector_termux_none():
    detector = DisplayDetector(is_termux=True)
    with patch.dict(os.environ, {}, clear=True), \
         patch("chroot_distro.helpers.display.resolve_invoking_uid", return_value=1000), \
         patch("os.path.exists", return_value=False):
        mode, display, wayland_display, xdg_runtime_dir = detector.detect()
        assert mode == DisplayMode.NONE
        assert display == ":0"
        assert wayland_display == "wayland-1"
        assert xdg_runtime_dir.endswith("/tmp")

def test_display_detector_wayland_exists():
    detector = DisplayDetector(is_termux=False)
    with patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-2", "XDG_RUNTIME_DIR": "/run/user/1000"}, clear=True), \
         patch("chroot_distro.helpers.display.resolve_invoking_uid", return_value=1000), \
         patch("os.path.exists", side_effect=lambda path: path == "/run/user/1000/wayland-2"):
        mode, display, wayland_display, xdg_runtime_dir = detector.detect()
        assert mode == DisplayMode.WAYLAND_ONLY
        assert display == ":1"
        assert wayland_display == "wayland-2"
        assert xdg_runtime_dir == "/run/user/1000"

def test_display_detector_xwayland_hybrid():
    detector = DisplayDetector(is_termux=False)
    with patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-0", "DISPLAY": ":2"}, clear=True), \
         patch("chroot_distro.helpers.display.resolve_invoking_uid", return_value=1000), \
         patch("os.path.exists", side_effect=lambda path: path in ("/run/user/1000/wayland-0", "/tmp/.X11-unix/X2")):
        mode, display, wayland_display, xdg_runtime_dir = detector.detect()
        assert mode == DisplayMode.XWAYLAND_HYBRID
        assert display == ":2"
        assert wayland_display == "wayland-0"

def test_wayland_config_linux():
    config = WaylandConfig(is_termux=False)
    with patch("os.path.exists", return_value=True):
        binds, env = config.configure("wayland-0", "/run/user/1000", 1001)
        assert binds == [("/run/user/1000/wayland-0", "/run/user/1001/wayland-0")]
        assert env["WAYLAND_DISPLAY"] == "wayland-0"
        assert env["XDG_RUNTIME_DIR"] == "/run/user/1001"

def test_wayland_config_termux():
    config = WaylandConfig(is_termux=True)
    with patch("os.path.exists", side_effect=lambda path: "usr/tmp" in path):
        binds, env = config.configure("wayland-1", "/data/data/com.termux/files/usr/tmp", 1001)
        assert len(binds) == 1
        assert binds[0][1] == "/run/user/1001/wayland-1"
        assert env["WAYLAND_DISPLAY"] == "wayland-1"

def test_gpu_config_linux():
    config = GPUConfig(is_termux=False)
    with patch("os.path.exists", return_value=True), \
         patch("os.listdir", return_value=["card0", "renderD128"]), \
         patch("os.access", return_value=True):
        binds = config.configure()
        assert len(binds) == 2
        assert ("/dev/dri/card0", "/dev/dri/card0") in binds
        assert ("/dev/dri/renderD128", "/dev/dri/renderD128") in binds

def test_gpu_config_termux():
    config = GPUConfig(is_termux=True)
    binds = config.configure()
    assert binds == []

def test_audio_config_linux():
    config = AudioConfig(is_termux=False)
    with patch("os.path.exists", side_effect=lambda path: "pulse/native" in path or "pipewire-0" in path):
        binds, env = config.configure("/run/user/1000", 1001)
        assert ("/run/user/1000/pulse/native", "/run/user/1001/pulse/native") in binds
        assert ("/run/user/1000/pipewire-0", "/run/user/1001/pipewire-0") in binds
        assert env["PULSE_SERVER"] == "unix:/run/user/1001/pulse/native"
        assert env["PIPEWIRE_RUNTIME_DIR"] == "/run/user/1001"

def test_audio_config_termux():
    config = AudioConfig(is_termux=True)
    binds, env = config.configure("/run/user/1000", 1001)
    assert binds == []
    assert env["PULSE_SERVER"] == "127.0.0.1"

def test_dbus_config_linux():
    config = DBusConfig(is_termux=False)
    with patch("os.path.exists", side_effect=lambda path: "bus" in path or "system_bus_socket" in path):
        binds, env = config.configure("/run/user/1000", 1001)
        assert ("/run/user/1000/bus", "/run/user/1001/bus") in binds
        assert ("/run/dbus/system_bus_socket", "/run/dbus/system_bus_socket") in binds
        assert env["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=/run/user/1001/bus"

def test_dbus_config_termux():
    config = DBusConfig(is_termux=True)
    binds, env = config.configure("/run/user/1000", 1001)
    assert binds == []
    assert env == {}

def test_configure_display_forwarding_facade():
    with patch("chroot_distro.helpers.display.DisplayDetector.detect", return_value=(DisplayMode.XWAYLAND_HYBRID, ":1", "wayland-0", "/run/user/1000")), \
         patch("chroot_distro.helpers.display.WaylandConfig.configure", return_value=([("/run/user/1000/wayland-0", "/run/user/1000/wayland-0")], {"WAYLAND_DISPLAY": "wayland-0"})), \
         patch("chroot_distro.helpers.display.X11Config.configure", return_value=([("/tmp/.X11-unix", "/tmp/.X11-unix")], {"DISPLAY": ":1"}, ["/home/user/.Xauthority"])), \
         patch("chroot_distro.helpers.display.GPUConfig.configure", return_value=[("/dev/dri/card0", "/dev/dri/card0")]), \
         patch("chroot_distro.helpers.display.AudioConfig.configure", return_value=([], {"PULSE_SERVER": "127.0.0.1"})), \
         patch("chroot_distro.helpers.display.DBusConfig.configure", return_value=([], {})):
        
        config = configure_display_forwarding(
            rootfs="/fake/rootfs",
            is_termux=False,
            isolated=False,
            dist_type="normal",
            login_user="user",
            login_uid=1000,
            login_gid=1000,
        )
        assert config.mode == DisplayMode.XWAYLAND_HYBRID
        assert ("/run/user/1000/wayland-0", "/run/user/1000/wayland-0") in config.binds
        assert ("/tmp/.X11-unix", "/tmp/.X11-unix") in config.binds
        assert ("/dev/dri/card0", "/dev/dri/card0") in config.binds
        assert config.env["WAYLAND_DISPLAY"] == "wayland-0"
        assert config.env["DISPLAY"] == ":1"
        assert config.x11_auth_binds == ["/home/user/.Xauthority"]
