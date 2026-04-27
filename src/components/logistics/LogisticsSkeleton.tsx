export default function LogisticsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando logística">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
        ))}
      </div>
      <div className="h-64 rounded-xl border border-border bg-card animate-pulse" />
      <div className="h-96 rounded-xl border border-border bg-card animate-pulse" />
    </div>
  );
}
