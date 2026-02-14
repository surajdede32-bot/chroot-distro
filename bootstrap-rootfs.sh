#!/usr/bin/env bash
##
## Script for building rootfs archives for chroot-distro.
## Based on proot-distro's bootstrap-rootfs.sh.
##

set -e -u

if [ "$(uname -o)" = "Android" ]; then
	echo "[!] This script cannot be executed on Android OS."
	exit 1
fi

for i in curl git jq mmdebstrap sudo tar xz; do
	if [ -z "$(command -v "$i")" ]; then
		echo "[!] '$i' is not installed."
		exit 1
	fi
done

SCRIPT_DIR=$(dirname "$(realpath "$0")")

# Where to look for distribution build recipes
BUILD_DIR="${SCRIPT_DIR}/distro-build"

# Where to put generated rootfs tarballs.
ROOTFS_DIR="${SCRIPT_DIR}/rootfs"

# Working directory where chroots will be created.
WORKDIR=/tmp/chroot-distro-bootstrap

# Normalize architecture names.
# Prefer aarch64, arm, i686, riscv64, x86_64 architecture names
# just like used by termux-packages.
translate_arch() {
	case "$1" in
	aarch64 | arm64 | arm64v8) echo "aarch64" ;;
	arm | armel | armhf | armhfp | armv7 | armv7l | armv7a | armv8l) echo "arm" ;;
	386 | i386 | i686 | x86) echo "i686" ;;
	riscv64) echo "riscv64" ;;
	amd64 | x86_64) echo "x86_64" ;;
	*)
		echo "translate_arch(): unknown arch '$1'" >&2
		exit 1
		;;
	esac
}

# Check if architecture should be skipped
should_skip_arch() {
	local arch=$(translate_arch "$1")
	# SKIP_ARCHS is space-separated list of architectures to skip
	for skip in ${SKIP_ARCHS:-}; do
		if [ "$arch" = "$skip" ]; then
			return 0 # true, should skip
		fi
	done
	return 1 # false, do not skip
}

# Common way to archive the rootfs.
# Usage: archive_rootfs /path/to/rootfs.tar.xz rootfs-dir
# rootfs-dir is relative to $WORKDIR
archive_rootfs() {
	SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(date +%s)}"
	echo "SOURCE_DATE_EPOCH: ${SOURCE_DATE_EPOCH}"

	# Inject serviced.py if it exists
	local serviced_path="${SCRIPT_DIR}/serviced/serviced.py"
	if [ -f "$serviced_path" ]; then
		echo "[*] Injecting serviced.py..."
		sudo mkdir -p "${2:?}/usr/bin"
		sudo cp "$serviced_path" "${2}/usr/bin/serviced"
		sudo chmod 755 "${2}/usr/bin/serviced"
	else
		echo "[!] Warning: serviced.py not found at $serviced_path"
	fi

	sudo find "${2:?}/dev" -mindepth 1 -delete
	sudo find "${2}" -type d -perm -400 -print0 | xargs -0 sudo chmod 755

	sudo rm -f "${1:?}.tmp"
	sudo tar \
		--directory="$WORKDIR" \
		--create \
		--sort=name \
		--hard-dereference \
		--mtime="@${SOURCE_DATE_EPOCH}" \
		--numeric-owner \
		--preserve-permissions \
		--acls \
		--xattrs \
		--xattrs-include='*' \
		--xz \
		--file="${1}.tmp" \
		"$2"
	sudo chown $(id -un):$(id -gn) "${1}.tmp"
	mv "${1}.tmp" "${1}"
}

##############################################################################

# Reset workspace. This also deletes any previously made rootfs tarballs.
sudo rm -rf "${WORKDIR:?}"
mkdir -p "$ROOTFS_DIR" "$WORKDIR"
cd "$WORKDIR"

# Build distribution. if no argument is supplied then all distributions will be built
if [ "$#" -gt 0 ]; then
	DISTRIBUTIONS="$*"
else
	DISTRIBUTIONS="$(
		cd ${BUILD_DIR}
		ls -1 *.sh | sed 's/.sh//'
	)"
fi

# Loop over to build a specified distribution
for distro in ${DISTRIBUTIONS}; do
	# Check distribution recipe that is about to built. if it doesn't exist. continue to next distribution
	if [ ! -f "${BUILD_DIR}/${distro}.sh" ]; then
		continue
	fi

	. "${BUILD_DIR}/${distro}.sh"
	printf "\n[*] Building ${dist_name:=$distro}...\n"

	# Bootstrap step
	# If the function does not exists, abort to indicate there's an error occured during build
	if ! declare -F bootstrap_distribution &>/dev/null; then
		echo "[!] Failure to build rootfs ${distro}, missing bootstrap_distribution function. aborting..."
		exit 1
	fi
	bootstrap_distribution

	# Cleanup variables and functions
	unset dist_name dist_version
	unset -f bootstrap_distribution
done
