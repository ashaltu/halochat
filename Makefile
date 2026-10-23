.PHONY: all install build test e2ee-test e2ee-wasm-check e2ee-wasm-test test-e2e dev-server dev-support dev-mobile clean check rust-check

WASM_BINDGEN ?= wasm-bindgen

all: install build test

install:
	pnpm install

build:
	pnpm build

test: e2ee-test
	pnpm test

e2ee-test:
	cargo test --locked --manifest-path packages/e2ee-core/Cargo.toml

e2ee-wasm-check:
	cargo check --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown
	cargo clippy --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown -- -D warnings

e2ee-wasm-test: e2ee-wasm-check
	cargo build --locked --manifest-path packages/e2ee-core/Cargo.toml --target wasm32-unknown-unknown --release
	$(WASM_BINDGEN) packages/e2ee-core/target/wasm32-unknown-unknown/release/halochat_e2ee_core.wasm --target nodejs --out-dir packages/e2ee-core/target/wasm-node
	node packages/e2ee-core/tests/wasm-roundtrip.cjs

test-e2e:
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
	cargo clippy --locked --manifest-path packages/e2ee-core/Cargo.toml -- -D warnings

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist
