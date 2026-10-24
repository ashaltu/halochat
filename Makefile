.PHONY: all install build test e2ee-test e2ee-native-check e2ee-mobile-check e2ee-native-libs e2ee-bindings e2ee-wasm-check e2ee-wasm-test e2ee-wasm-web e2ee-wasm-browser-assets e2ee-wasm-browser-test e2ee-android-module-check e2ee-ios-module-check e2ee-platform-module-check test-e2e dev-server dev-support dev-mobile mobile-web-build clean check rust-check

WASM_BINDGEN ?= wasm-bindgen
CARGO_ENV ?= CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0

all: install build test

install:
	pnpm install

build:
	pnpm build

test: e2ee-test
	pnpm test

e2ee-test:
	$(CARGO_ENV) cargo test --locked --manifest-path packages/e2ee-core/Cargo.toml

e2ee-native-check:
	$(CARGO_ENV) cargo test --locked --manifest-path packages/e2ee-core/Cargo.toml --features native-bindings
	$(CARGO_ENV) cargo clippy --locked --manifest-path packages/e2ee-core/Cargo.toml --features native-bindings -- -D warnings

e2ee-bindings:
	cd packages/e2ee-core && $(CARGO_ENV) cargo build --locked --features binding-generation
	cd packages/e2ee-core && $(CARGO_ENV) cargo run --locked --features binding-generation --bin uniffi-bindgen -- generate --no-format --library target/debug/libhalochat_e2ee_core.dylib --language swift --out-dir target/uniffi/swift
	cd packages/e2ee-core && $(CARGO_ENV) cargo run --locked --features binding-generation --bin uniffi-bindgen -- generate --no-format --library target/debug/libhalochat_e2ee_core.dylib --language kotlin --out-dir target/uniffi/kotlin
	mkdir -p apps/mobile/modules/halochat-e2ee/ios/generated apps/mobile/modules/halochat-e2ee/android/src/main/java/uniffi/halochat_e2ee_core
	cp packages/e2ee-core/target/uniffi/swift/halochat_e2ee_core.swift packages/e2ee-core/target/uniffi/swift/halochat_e2ee_coreFFI.h packages/e2ee-core/target/uniffi/swift/halochat_e2ee_coreFFI.modulemap apps/mobile/modules/halochat-e2ee/ios/generated/
	cp packages/e2ee-core/target/uniffi/kotlin/uniffi/halochat_e2ee_core/halochat_e2ee_core.kt apps/mobile/modules/halochat-e2ee/android/src/main/java/uniffi/halochat_e2ee_core/
	perl -0pi -e 's/[ \t]+\n/\n/g; s/\n*\z/\n/' apps/mobile/modules/halochat-e2ee/ios/generated/halochat_e2ee_core.swift apps/mobile/modules/halochat-e2ee/ios/generated/halochat_e2ee_coreFFI.h apps/mobile/modules/halochat-e2ee/ios/generated/halochat_e2ee_coreFFI.modulemap apps/mobile/modules/halochat-e2ee/android/src/main/java/uniffi/halochat_e2ee_core/halochat_e2ee_core.kt
	swiftc -module-cache-path packages/e2ee-core/target/swift-module-cache -Xcc -fmodule-map-file=packages/e2ee-core/target/uniffi/swift/halochat_e2ee_coreFFI.modulemap -I packages/e2ee-core/target/uniffi/swift -L packages/e2ee-core/target/debug -lhalochat_e2ee_core packages/e2ee-core/target/uniffi/swift/halochat_e2ee_core.swift -emit-module -module-name halochat_e2ee_core -emit-module-path packages/e2ee-core/target/uniffi/swift/halochat_e2ee_core.swiftmodule
	swiftc -module-cache-path packages/e2ee-core/target/swift-module-cache -Xcc -fmodule-map-file=packages/e2ee-core/target/uniffi/swift/halochat_e2ee_coreFFI.modulemap -I packages/e2ee-core/target/uniffi/swift -L packages/e2ee-core/target/debug -lhalochat_e2ee_core -Xlinker -rpath -Xlinker $(CURDIR)/packages/e2ee-core/target/debug packages/e2ee-core/target/uniffi/swift/halochat_e2ee_core.swift packages/e2ee-core/tests/swift-roundtrip.swift -o packages/e2ee-core/target/swift-roundtrip
	packages/e2ee-core/target/swift-roundtrip

e2ee-mobile-check:
	$(CARGO_ENV) cargo check --locked --manifest-path packages/e2ee-core/Cargo.toml --features native-bindings --target aarch64-apple-ios
	$(CARGO_ENV) cargo check --locked --manifest-path packages/e2ee-core/Cargo.toml --features native-bindings --target aarch64-linux-android

e2ee-native-libs: e2ee-bindings
	bash packages/e2ee-core/scripts/build-native-libs.sh

e2ee-android-module-check:
	cd apps/mobile/android && ./gradlew :halochat-e2ee-native:compileDebugKotlin --console=plain

e2ee-ios-module-check:
	cd apps/mobile/ios && xcodebuild -quiet -project Pods/Pods.xcodeproj -target HaloChatE2ee -sdk iphonesimulator -configuration Debug SYMROOT=/private/tmp/halochat-e2ee-ios-products OBJROOT=/private/tmp/halochat-e2ee-ios-intermediates CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build

e2ee-platform-module-check: e2ee-android-module-check e2ee-ios-module-check

e2ee-wasm-check:
	$(CARGO_ENV) cargo check --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown
	$(CARGO_ENV) cargo clippy --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown -- -D warnings

e2ee-wasm-test: e2ee-wasm-check
	$(CARGO_ENV) cargo build --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown --release
	$(WASM_BINDGEN) packages/e2ee-core/target/wasm32-unknown-unknown/release/halochat_e2ee_core.wasm --target nodejs --out-dir packages/e2ee-core/target/wasm-node
	node packages/e2ee-core/tests/wasm-roundtrip.cjs

e2ee-wasm-web: e2ee-wasm-check
	$(CARGO_ENV) cargo build --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown --release
	mkdir -p apps/mobile/modules/halochat-e2ee/src/wasm
	$(WASM_BINDGEN) packages/e2ee-core/target/wasm32-unknown-unknown/release/halochat_e2ee_core.wasm --target web --out-dir apps/mobile/modules/halochat-e2ee/src/wasm
	mkdir -p apps/mobile/public
	cp apps/mobile/modules/halochat-e2ee/src/wasm/halochat_e2ee_core_bg.wasm apps/mobile/public/

e2ee-wasm-browser-assets: e2ee-wasm-web
	pnpm exec esbuild tests/e2e/fixtures/e2ee-web-store-entry.ts --bundle --platform=browser --format=esm --outfile=/private/tmp/halochat-e2ee-web-store-entry.js

e2ee-wasm-browser-test: e2ee-wasm-browser-assets
	pnpm exec playwright test tests/e2e/e2ee-wasm.spec.ts

mobile-web-build: e2ee-wasm-web
	pnpm --filter @halochat/mobile exec expo export --platform web

test-e2e: e2ee-wasm-browser-assets
	pnpm test:e2e

dev-server:
	pnpm dev:server

dev-support:
	pnpm dev:support

dev-mobile:
	pnpm dev:mobile

check: rust-check
	pnpm --filter "@halochat/*" run typecheck

rust-check:
	cargo fmt --manifest-path packages/e2ee-core/Cargo.toml -- --check
	$(CARGO_ENV) cargo clippy --locked --manifest-path packages/e2ee-core/Cargo.toml -- -D warnings

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist
