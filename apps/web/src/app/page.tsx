/**
 * Phase 0 placeholder.
 *
 * Its only job is to prove that the Next.js app compiles, renders and resolves the
 * workspace `shared` package. Real screens (shows list, seat map, checkout) arrive
 * in Phase 7; deliberately nothing here pretends to be a feature.
 */
const WORKSPACE_PACKAGES = [
  { name: 'apps/api', purpose: 'Fastify API skeleton with GET /health (Postgres + Redis probes)' },
  { name: 'apps/web', purpose: 'This Next.js app (App Router)' },
  { name: 'packages/shared', purpose: 'Shared types and constants (health + error contracts)' },
] as const;

export default function HomePage() {
  return (
    <main className="page">
      <span className="badge">Phase 0 &middot; Setup &amp; Foundation</span>
      <h1>SeatRush</h1>
      <p className="lede">
        The pnpm workspace is wired up. No product features are implemented yet &mdash; check{' '}
        <code>TRACKER.md</code> for progress and <code>docs/adr/</code> for design decisions.
      </p>

      <ul className="packages">
        {WORKSPACE_PACKAGES.map((item) => (
          <li key={item.name}>
            <code>{item.name}</code>
            <br />
            {item.purpose}
          </li>
        ))}
      </ul>
    </main>
  );
}
