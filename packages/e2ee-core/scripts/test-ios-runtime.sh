#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
module_dir="$repo_root/apps/mobile/modules/halochat-e2ee/ios"
framework="$module_dir/halochat_e2ee_coreFFI.xcframework"
framework_slice="$framework/ios-arm64_x86_64-simulator"
device_id="${IOS_SIMULATOR_ID:-booted}"
bundle_id="com.ashaltu.halochat.e2eeruntime"
app_name="HaloChatE2eeRuntime.app"
app_dir="$(mktemp -d /private/tmp/halochat-e2ee-ios-runtime.XXXXXX)"
cleanup() {
  xcrun simctl uninstall "$device_id" "$bundle_id" >/dev/null 2>&1 || true
  rm -rf "$app_dir"
}
trap cleanup EXIT
mkdir -p "$app_dir/$app_name"

if [[ ! -d "$framework_slice/halochat_e2ee_coreFFI.framework" ]]; then
  make -C "$repo_root" e2ee-native-libs
fi

sdk_path="$(xcrun --sdk iphonesimulator --show-sdk-path)"
swiftc \
  -target arm64-apple-ios17.0-simulator \
  -sdk "$sdk_path" \
  -F "$framework_slice" \
  -framework halochat_e2ee_coreFFI \
  "$module_dir/generated/halochat_e2ee_core.swift" \
  "$repo_root/packages/e2ee-core/tests/ios-runtime-app.swift" \
  -o "$app_dir/$app_name/HaloChatE2eeRuntime"

cat > "$app_dir/$app_name/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>HaloChatE2eeRuntime</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>HaloChatE2eeRuntime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
</dict></plist>
EOF

codesign --force --sign - "$app_dir/$app_name" >/dev/null
xcrun simctl install "$device_id" "$app_dir/$app_name"
xcrun simctl launch "$device_id" "$bundle_id" >/dev/null
data_dir="$(xcrun simctl get_app_container "$device_id" "$bundle_id" data)"
result_file="$data_dir/Documents/e2ee-runtime-result.txt"

for _ in $(seq 1 30); do
  if [[ -f "$result_file" ]]; then
    result="$(cat "$result_file")"
    if [[ "$result" == "passed" ]]; then
      echo "iOS simulator MLS, device-binding, messaging, and state-protection round trip passed."
      exit 0
    fi
    echo "$result" >&2
    exit 1
  fi
  sleep 1
done

echo "iOS simulator E2EE runtime test did not write a result." >&2
exit 1
