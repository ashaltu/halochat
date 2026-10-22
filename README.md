# HaloChat

HaloChat is a one-to-one text messaging application designed to make conversations comfortable and safe. Users can chat directly or involve trusted guardians and mentors called **Angels** in selected conversations without turning chats into group conversations.

---

## Key Concepts

- **Comfort Mode**: Private, direct one-to-one conversation without Angel supervision.
- **Protected Mode**: Selected conversations overseen by assigned Angels who can pause sending, end chats, or send private whispers without being participants in the conversation.
- **Recipient-First Routing**: Recipient accepts or declines contact first before any Angel approval thresholds are evaluated.
- **Role Privacy (§5.1)**: Chat participants cannot see the other person's Angel identities or count. Rejoin history gaps and private decline reasons are protected.

---

## Monorepo Layout

- **`apps/server`**: Hono API, Better Auth session handling, and realtime WebSockets (`/ws`).
- **`apps/mobile`**: Expo (React Native + Web) client with Expo Router.
- **`apps/support`**: Private admin web interface for safety reports, session revocation, and profile corrections.
- **`packages/shared`**: Shared Zod schemas, domain enums, matching engine, and privacy filters.
- **`packages/db`**: Drizzle ORM schemas supporting PostgreSQL (Neon / local) and in-memory PGlite.
- **`tests/integration`**: Integration test suite verifying end-to-end flows.

---

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 10+
- GNU Make
- Rust 1.91+ and Cargo (used by the OpenMLS protocol tests in `make test`)

### Quick Start

```bash
# 1. Install dependencies
make install

# 2. Run automated integration test suite
make test

# 3. Build all packages and applications
make build

# 4. Start the backend server (http://localhost:3000, ws://localhost:3000/ws)
make dev-server

# 5. Start the mobile/web app (http://localhost:8081)
make dev-mobile

# 6. Start the private admin support web UI (http://localhost:3001)
make dev-support
```

---

## License

**Proprietary and Confidential.**

Copyright © 2026 HaloChat. All rights reserved.

This software and associated documentation files are the proprietary and confidential property of HaloChat. Unauthorized copying, distribution, modification, public display, or reverse engineering of this software, via any medium, is strictly prohibited.
