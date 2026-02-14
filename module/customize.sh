#!/system/bin/sh
# shellcheck disable=SC2034
##########################################################################################
# Config Flags
##########################################################################################
# Set to true if you do *NOT* want Magisk to mount
# any files for you. Most modules would NOT want
# to set this flag to true
SKIPMOUNT=false

# Set to true if you need to load system.prop
PROPFILE=false

# Set to true if you need post-fs-data script
POSTFSDATA=false

# Set to true if you need late_start service script
LATESTARTSERVICE=false

# BusyBox version check - MUST be before any other operations
ui_print "- Checking BusyBox compatibility..."

if ! command -v busybox >/dev/null 2>&1; then
    ui_print "! BusyBox is not installed. Please install BusyBox v1.36.1 or newer."
    abort "! Installation aborted due to missing BusyBox"
fi

current_version=$(busybox | sed -n 's/.* v\([0-9.]*\).*/\1/p')
if [ -z "$current_version" ]; then
    ui_print "! Unable to determine BusyBox version"
    abort "! Installation aborted due to BusyBox version detection failure"
fi

numeric_version=$(echo "$current_version" | tr -d '.')
if [ "$numeric_version" -lt 1361 ]; then
    ui_print "! The installed BusyBox version ($current_version) is outdated and may cause compatibility issues."
    ui_print "! Upgrade to BusyBox v1.36.1 or newer for optimal performance."
    abort "! Installation aborted due to outdated BusyBox version"
fi

ui_print "- BusyBox version $current_version detected - Compatible!"
