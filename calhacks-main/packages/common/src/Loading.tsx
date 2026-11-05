// Every store shows this while a page waits on the catalog. Built pages already hold their data, so it only appears on a cold cache.
export default function Loading() {
  return (
    <div className="page-loading" role="status">
      <span className="page-loading-spinner" aria-hidden />
      <span className="sr-only">Loading</span>
    </div>
  );
}
