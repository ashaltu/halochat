#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
core_manifest="$repo_root/packages/e2ee-core/Cargo.toml"
target_dir="$repo_root/packages/e2ee-core/target"
module_dir="$repo_root/apps/mobile/modules/halochat-e2ee"
ndk_root="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_HOME:-}/ndk/27.1.12297006}}"

if [[ ! -d "$ndk_root/toolchains/llvm/prebuilt/darwin-x86_64/bin" ]]; then
  echo "Android NDK not found at $ndk_root" >&2
  exit 1
fi

ndk_bin="$ndk_root/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ndk_bin/aarch64-linux-android24-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$ndk_bin/x86_64-linux-android24-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export CC_x86_64_linux_android="$CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER"
ios_targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)
for target in "${ios_targets[@]}" aarch64-linux-android x86_64-linux-android; do
  cargo build --locked --manifest-path "$core_manifest" --release --features native-bindings --target "$target"
done

ios_framework="$target_dir/native/halochat_e2ee_coreFFI.xcframework"
simulator_lib="$target_dir/native/libhalochat_e2ee_simulator.a"
device_framework="$target_dir/native/device/halochat_e2ee_coreFFI.framework"
simulator_framework="$target_dir/native/simulator/halochat_e2ee_coreFFI.framework"
mkdir -p "$target_dir/native" "$device_framework/Headers" "$device_framework/Modules" "$simulator_framework/Headers" "$simulator_framework/Modules"
cp "$target_dir/uniffi/swift/halochat_e2ee_coreFFI.h" "$device_framework/Headers/"
cp "$target_dir/uniffi/swift/halochat_e2ee_coreFFI.h" "$simulator_framework/Headers/"
cat > "$device_framework/Modules/module.modulemap" <<'EOF'
framework module halochat_e2ee_coreFFI {
  umbrella header "halochat_e2ee_coreFFI.h"
  export *
}
EOF
cp "$device_framework/Modules/module.modulemap" "$simulator_framework/Modules/module.modulemap"
cat > "$device_framework/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>halochat_e2ee_coreFFI</string>
  <key>CFBundleIdentifier</key><string>org.halochat.e2ee.coreffi</string>
  <key>CFBundleName</key><string>halochat_e2ee_coreFFI</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>15.1</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
</dict></plist>
EOF
cp "$device_framework/Info.plist" "$simulator_framework/Info.plist"
lipo -create \
  "$target_dir/x86_64-apple-ios/release/libhalochat_e2ee_core.a" \
  "$target_dir/aarch64-apple-ios-sim/release/libhalochat_e2ee_core.a" \
  -output "$simulator_lib"
cp "$target_dir/aarch64-apple-ios/release/libhalochat_e2ee_core.a" "$device_framework/halochat_e2ee_coreFFI"
cp "$simulator_lib" "$simulator_framework/halochat_e2ee_coreFFI"
rm -rf "$ios_framework"
xcodebuild -create-xcframework \
  -framework "$device_framework" \
  -framework "$simulator_framework" \
  -output "$ios_framework"
cp -R "$ios_framework" "$module_dir/ios/"

android_libs="$module_dir/android/src/main/jniLibs"
mkdir -p "$android_libs/arm64-v8a" "$android_libs/x86_64"
cp "$target_dir/aarch64-linux-android/release/libhalochat_e2ee_core.so" "$android_libs/arm64-v8a/"
cp "$target_dir/x86_64-linux-android/release/libhalochat_e2ee_core.so" "$android_libs/x86_64/"

echo "Built iOS XCFramework and Android arm64/x86_64 libraries for the Expo module."
