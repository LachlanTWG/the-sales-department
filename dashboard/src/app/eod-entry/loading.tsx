export default function EodEntryLoading() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-md px-5 py-4">
        <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1">
          <div className="rounded-md bg-zinc-700/70 px-3 py-1.5 text-center text-xs font-semibold text-zinc-100">
            Log
          </div>
          <div className="rounded-md px-3 py-1.5 text-center text-xs text-zinc-500">Today</div>
          <div className="rounded-md px-3 py-1.5 text-center text-xs text-zinc-500">Me</div>
        </div>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    </main>
  );
}
