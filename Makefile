.PHONY: all install build test e2ee-test test-e2e dev-server dev-support dev-mobile clean check rust-check

all: install build test

install:
	pnpm install

build:
	pnpm build

test: e2ee-test
	pnpm test

e2ee-test:
	cargo test --locked --manifest-path packages/e2ee-core/Cargo.toml

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
