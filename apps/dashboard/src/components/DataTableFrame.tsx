import type { ReactNode } from "react";

export function DataTableFrame({
  children,
  ariaLabel,
}: {
  children: ReactNode;
  ariaLabel?: string;
}) {
  const className = "overflow-x-auto rounded-lg border bg-card";

  if (ariaLabel !== undefined) {
    return (
      <section aria-label={ariaLabel} className={className}>
        {children}
      </section>
    );
  }

  return <div className={className}>{children}</div>;
}
