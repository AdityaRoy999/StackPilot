export default function ProjectLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-label="Loading project">
      <div className="h-9 w-72 rounded-lg bg-muted" />
      <div className="h-5 w-96 max-w-full rounded-lg bg-muted/70" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-36 rounded-xl bg-muted/60" />
        <div className="h-36 rounded-xl bg-muted/60" />
        <div className="h-36 rounded-xl bg-muted/60" />
      </div>
      <div className="h-64 rounded-xl bg-muted/50" />
    </div>
  );
}
