.PHONY: all install build test dev-server dev-support dev-mobile clean check

all: install build test

install:
	pnpm install

build:
	pnpm build

test:
	pnpm test

dev-server:
	pnpm dev:server

dev-support:
	pnpm dev:support

dev-mobile:
	pnpm dev:mobile

check:
	pnpm --filter "@halochat/*" run typecheck || true

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist
