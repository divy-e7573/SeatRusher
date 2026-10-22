# infra/

Operational assets that are not application code.

| Path                    | Purpose                                                                                                                             | Status          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `../docker-compose.yml` | Local PostgreSQL + Redis. Kept at the repo root so `docker compose up -d` works with no `-f` flag, as the Phase 0 requirements ask. | Active          |
| `k6/`                   | Load-test scripts for Phase 9.                                                                                                      | Not created yet |

`AGENTS.md` sketches `infra/docker-compose`, but Phase 0 requires a root
`docker-compose.yml`. The root file is the single source of truth; this folder
exists so Phase 9 has an obvious home for k6 scripts.
