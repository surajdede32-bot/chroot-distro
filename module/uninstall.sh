#!/system/bin/sh

# Base directory where script keeps runtime data
RUNTIME_DIR=/data/local/chroot-distro
# Where extracted rootfs are stored.
INSTALLED_ROOTFS_DIR="${RUNTIME_DIR}/installed-rootfs"

# Function to cleanup a single distro
cleanup_distro() {
    distro_name="$1"
    rootfs="${INSTALLED_ROOTFS_DIR}/${distro_name}"

    if [ -z "$distro_name" ] || [ ! -d "$rootfs" ]; then
        ui_print "  ! Distro '$distro_name' not found or invalid"
        return 1
    fi

    ui_print "  - Cleaning up distro: $distro_name"

    # Kill processes using the rootfs
    ui_print "- Killing processes using rootfs..."
    busybox fuser -k "$rootfs" 2>/dev/null || true

    # Find all mount points under rootfs and unmount in reverse order
    ui_print "- Unmounting filesystems..."
    grep " ${rootfs}" /proc/mounts 2>/dev/null |
        awk '{print $2}' |
        sort -r |
        while IFS= read -r mount_point; do
            ui_print "- Unmounting: $mount_point"
            busybox umount "$mount_point" 2>/dev/null ||
                busybox umount -l "$mount_point" 2>/dev/null || true
        done

    ui_print "- Distro $distro_name cleanup completed"
    return 0
}

# Main cleanup process
ui_print "- Removing module data"
if command -v busybox >/dev/null 2>&1; then
    # Check if installed rootfs directory exists
    if [ ! -d "$INSTALLED_ROOTFS_DIR" ]; then
        ui_print "- ! No installed rootfs directory found"
    else
        ui_print "- Processing installed distributions..."

        # List and process each distro
        found_distros=0
        for distro_dir in "$INSTALLED_ROOTFS_DIR"/*; do
            # Check if glob matched anything and if it's a directory
            if [ -d "$distro_dir" ]; then
                found_distros=1
                distro_name="${distro_dir##*/}"
                cleanup_distro "$distro_name"
            fi
        done

        if [ "$found_distros" -eq 0 ]; then
            ui_print "- ! No installed distributions found"
        fi
    fi
fi
# Remove the entire runtime directory
ui_print "- Removing runtime directory: $RUNTIME_DIR"
rm -rf "$RUNTIME_DIR"

ui_print "- Module data removal completed"
