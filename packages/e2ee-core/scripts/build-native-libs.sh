#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
core_manifest="$repo_root/packages/e2ee-core/Cargo.toml"
target_dir="$repo_root/packages/e2ee-core/target"
module_dir="$repo_root/apps/mobile/modules/halochat-e2ee"
native_stage="/private/tmp/halochat-e2ee-native"
build_fingerprint="$(shasum -a 256 "$core_manifest" "$repo_root/packages/e2ee-core/Cargo.lock" "$repo_root/packages/e2ee-core/src/lib.rs" "$repo_root/packages/e2ee-core/src/ffi.rs" "$0" | shasum -a 256 | awk '{print $1}')"
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
if [[ -d "$native_stage" ]] && {
  [[ ! -f "$native_stage/.build-fingerprint" ]] ||
    [[ "$(cat "$native_stage/.build-fingerprint")" != "$build_fingerprint" ]]
}; then
  rm -rf "$native_stage"
fi
mkdir -p "$native_stage"
printf '%s\n' "$build_fingerprint" > "$native_stage/.build-fingerprint"
ios_framework="$native_stage/halochat_e2ee_coreFFI.xcframework"
device_framework="$native_stage/device/halochat_e2ee_coreFFI.framework"
simulator_framework="$native_stage/simulator/halochat_e2ee_coreFFI.framework"
simulator_arm64_lib="$native_stage/libhalochat_e2ee_simulator_arm64.a"
simulator_x86_64_lib="$native_stage/libhalochat_e2ee_simulator_x86_64.a"
simulator_lib="$native_stage/libhalochat_e2ee_simulator.a"
mkdir -p "$device_framework/Headers" "$device_framework/Modules" "$simulator_framework/Headers" "$simulator_framework/Modules"
if [[ ! -f "$native_stage/halochat_e2ee_coreFFI.h" ]]; then
  cp "$module_dir/ios/generated/halochat_e2ee_coreFFI.h" "$native_stage/"
fi

ios_targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)
for target in "${ios_targets[@]}"; do
  case "$target" in
    aarch64-apple-ios) output="$device_framework/halochat_e2ee_coreFFI" ;;
    aarch64-apple-ios-sim) output="$simulator_arm64_lib" ;;
    x86_64-apple-ios) output="$simulator_x86_64_lib" ;;
  esac
  if [[ -f "$output" ]]; then
    continue
  fi
  cargo build --locked --manifest-path "$core_manifest" --release --features native-bindings --target "$target"
  case "$target" in
    aarch64-apple-ios)
      cp "$target_dir/$target/release/libhalochat_e2ee_core.a" "$device_framework/halochat_e2ee_coreFFI"
      ;;
    aarch64-apple-ios-sim)
      cp "$target_dir/$target/release/libhalochat_e2ee_core.a" "$simulator_arm64_lib"
      ;;
    x86_64-apple-ios)
      cp "$target_dir/$target/release/libhalochat_e2ee_core.a" "$simulator_x86_64_lib"
      ;;
  esac
  cargo clean --manifest-path "$core_manifest" --target "$target"
done

cp "$native_stage/halochat_e2ee_coreFFI.h" "$device_framework/Headers/"
cp "$native_stage/halochat_e2ee_coreFFI.h" "$simulator_framework/Headers/"
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
lipo -create "$simulator_x86_64_lib" "$simulator_arm64_lib" -output "$simulator_lib"
cp "$simulator_lib" "$simulator_framework/halochat_e2ee_coreFFI"
rm -rf "$ios_framework"
xcodebuild -create-xcframework \
  -framework "$device_framework" \
  -framework "$simulator_framework" \
  -output "$ios_framework"
cp -R "$ios_framework" "$module_dir/ios/"

android_libs="$module_dir/android/src/main/jniLibs"
for target in aarch64-linux-android x86_64-linux-android; do
  cargo build --locked --manifest-path "$core_manifest" --release --features native-bindings --target "$target"
  case "$target" in
    aarch64-linux-android) android_abi=arm64-v8a ;;
    x86_64-linux-android) android_abi=x86_64 ;;
  esac
  mkdir -p "$android_libs/$android_abi"
  cp "$target_dir/$target/release/libhalochat_e2ee_core.so" "$android_libs/$android_abi/"
  cargo clean --manifest-path "$core_manifest" --target "$target"
done

rm -rf "$native_stage"

echo "Built iOS XCFramework and Android arm64/x86_64 libraries for the Expo module."
