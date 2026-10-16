.PHONY: all install build test test-e2e dev-server dev-support dev-mobile clean check

all: install build test

install:
	pnpm install

build:
	pnpm build

test:
	pnpm test

test-e2e:
	pnpm test:e2e

dev-server:
	pnpm dev:server

dev-support:
	pnpm dev:support

dev-mobile:
	pnpm dev:mobile

check:
	pnpm --filter "@halochat/*" run typecheck

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist
