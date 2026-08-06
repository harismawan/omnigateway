import { CircleAlert } from "lucide-react";
import { ApiError } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  const code = error instanceof ApiError ? error.code : null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm" role="alert">
      <div className="flex items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
        <p className="font-medium">{message}</p>
      </div>
      {code !== null && <p className="mt-1 text-muted-foreground">Code: {code}</p>}
      {onRetry !== undefined && (
        <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="outline">
          Retry
        </Button>
      )}
    </div>
  );
}
