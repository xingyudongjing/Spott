"use client";

export function OfflineRetry({ label }: { label: string }) {
  return (
    <button className="primary-action compact" type="button" onClick={() => window.location.reload()}>
      {label}
    </button>
  );
}
