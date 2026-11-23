#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

original='/Applications/ONLYOFFICE.app'
destination="$PWD/Media Drop for ONLYOFFICE.app"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

fail() {
    printf 'Media Drop: %s\n' "$*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)
            [[ $# -ge 2 ]] || fail '--source requires an app path'
            original=$2
            shift 2
            ;;
        --output)
            [[ $# -ge 2 ]] || fail '--output requires a new app path'
            destination=$2
            shift 2
            ;;
        --help|-h)
            printf 'Usage: %s [--source /path/to/ONLYOFFICE.app] [--output /path/to/New.app[.zip]]\n' "$0"
            exit 0
            ;;
        *) fail "Unknown argument: $1" ;;
    esac
done

[[ $(/usr/bin/uname -s) == Darwin && $(/usr/bin/uname -m) == arm64 ]] || fail 'Apple Silicon macOS is required'
command -v node >/dev/null || fail 'Node.js 22 or later is required'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22 or later is required'
[[ -d "$original" ]] || fail "ONLYOFFICE was not found at $original"
original=$(cd -- "$original" && pwd -P)
[[ "$destination" == *.app || "$destination" == *.app.zip ]] || fail 'The output path must end in .app or .app.zip'
destination_parent=$(cd -- "$(dirname -- "$destination")" && pwd -P) || fail 'Create the output parent directory first'
destination="$destination_parent/$(basename -- "$destination")"
[[ "$destination_parent/" != "$original/"* ]] || fail 'Choose an output directory outside the source app'
[[ ! -e "$destination" && ! -L "$destination" ]] || fail "Output already exists at $destination"

plist="$original/Contents/Info.plist"
plist_value() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }
[[ $(plist_value CFBundleIdentifier) == asc.onlyoffice.ONLYOFFICE &&
   $(plist_value CFBundleShortVersionString) == 10.0.0 &&
   $(plist_value CFBundleVersion) == 564 ]] || fail 'Expected ONLYOFFICE Desktop Editors 10.0.0 (564)'
[[ $(/usr/bin/file -b "$original/Contents/MacOS/ONLYOFFICE") == 'Mach-O 64-bit executable arm64'* ]] || fail 'Expected the arm64 app bundle'

printf 'Verifying the source app and presentation SDK…\n'
/usr/bin/codesign --verify --deep --strict "$original"
node "$script_dir/../src/sdk-10.0.0-169.mjs" --check "$original"

temp_root=${TMPDIR:-/tmp}
staging=$(/usr/bin/mktemp -d "${temp_root%/}/onlyoffice-media-drop-build.XXXXXXXX")
trap '/bin/rm -rf -- "$staging"' EXIT
candidate="$staging/$(basename -- "${destination%.zip}")"
printf 'Building the independent app…\n'
/usr/bin/ditto --noclone --norsrc --noextattr --noqtn "$original" "$candidate"
node "$script_dir/../src/sdk-10.0.0-169.mjs" "$candidate"

plist="$candidate/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier io.github.shaochang123.onlyoffice-media-drop' "$plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Media Drop for ONLYOFFICE' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Media Drop for ONLYOFFICE' "$plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleURLTypes' "$plist"
/usr/libexec/PlistBuddy -c 'Delete :SUFeedURL' "$plist"
/usr/libexec/PlistBuddy -c 'Add :SUEnableAutomaticChecks bool false' "$plist"

/usr/bin/xattr -cr "$candidate"
/usr/bin/codesign --force --sign - --preserve-metadata=entitlements,flags "$candidate"
/usr/bin/codesign --verify --deep --strict "$candidate"
artifact=$candidate
if [[ "$destination" == *.app.zip ]]; then
    artifact="$staging/$(basename -- "$destination")"
    /usr/bin/ditto -c -k --norsrc --noextattr --noqtn --keepParent "$candidate" "$artifact"
fi
[[ ! -e "$destination" && ! -L "$destination" ]] || fail "Output already exists at $destination"
/bin/mv -- "$artifact" "$destination"
if [[ "$destination" == *.app ]] && ! /usr/bin/codesign --verify --deep --strict "$destination"; then
    /bin/mv -- "$destination" "$staging/failed-output.app"
    fail 'Choose a local output folder for .app, or build a .app.zip for a synced folder'
fi
printf 'Built %s\n' "$destination"
