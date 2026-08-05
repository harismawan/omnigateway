import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client.ts";
import { credentialsQuery, qk, useInvalidate } from "@/api/queries.ts";
import type { ConnectFinish, ConnectPoll, ConnectStart, ProviderId } from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

export function ConnectDialog({
  provider,
  onClose,
  openWindow = (url: string) => {
    globalThis.open(url, "_blank", "noopener,noreferrer");
  },
}: {
  provider: ProviderId;
  onClose: () => void;
  openWindow?: (url: string) => void;
}) {
  const invalidate = useInvalidate();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [flow, setFlow] = useState<ConnectStart | null>(null);
  const [baseline, setBaseline] = useState<number | null>(null);
  const settled = useRef(false);

  const settle = useCallback(async (): Promise<void> => {
    if (settled.current) return;
    settled.current = true;
    await invalidate([qk.credentials()]);
    onClose();
  }, [invalidate, onClose]);

  const start = useMutation({
    mutationFn: () =>
      api.post<ConnectStart>("/api/connect/start", { provider, label: label.trim() }),
    onSuccess: (started) => {
      setFlow(started);
      openWindow(started.authorizeUrl);
    },
  });

  const finish = useMutation({
    mutationFn: () => {
      if (flow === null) throw new Error("authorization flow has not started");
      return api.post<ConnectFinish>("/api/connect/finish", {
        flowId: flow.flowId,
        code: code.trim(),
      });
    },
    onSuccess: () => void settle(),
  });

  const isDevice = flow?.kind === "device";
  const poll = useQuery({
    queryKey: ["connect", "poll", flow?.flowId ?? "none"],
    queryFn: () => {
      if (flow === null) throw new Error("authorization flow has not started");
      return api.post<ConnectPoll>("/api/connect/poll", { flowId: flow.flowId });
    },
    enabled: (query) => isDevice && query.state.status !== "error",
    refetchInterval: (query) =>
      isDevice && query.state.status !== "error" ? (flow?.pollIntervalMs ?? 5_000) : false,
    retry: false,
    staleTime: 0,
  });

  const watchingRedirect = flow?.kind === "pkce" && !flow.supportsManualPaste;
  const credentials = useQuery({
    ...credentialsQuery(),
    enabled: watchingRedirect,
    refetchInterval: watchingRedirect ? 2_000 : false,
  });

  useEffect(() => {
    if (watchingRedirect && credentials.data !== undefined && baseline === null) {
      setBaseline(credentials.data.length);
    }
  }, [baseline, credentials.data, watchingRedirect]);

  useEffect(() => {
    if (poll.data?.status === "complete") void settle();
  }, [poll.data, settle]);

  useEffect(() => {
    if (watchingRedirect && baseline !== null && (credentials.data?.length ?? 0) > baseline) {
      void settle();
    }
  }, [baseline, credentials.data, watchingRedirect, settle]);

  return (
    <div role="dialog" aria-label={`Connect ${PROVIDER_LABELS[provider]}`} className="mt-6">
      <Card className="max-w-lg p-5">
        <h2 className="text-sm font-semibold">Connect {PROVIDER_LABELS[provider]}</h2>
        {flow === null ? (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="connect-label">Label</Label>
              <Input
                id="connect-label"
                value={label}
                placeholder="work"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            {start.isError && <ErrorState error={start.error} />}
            <div className="flex gap-2">
              <Button disabled={start.isPending} onClick={() => start.mutate()}>
                Start authorization
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        ) : flow.kind === "device" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm">Enter this code at the provider:</p>
            <p className="font-mono text-2xl tracking-widest">{flow.userCode}</p>
            {poll.isError ? (
              <ErrorState error={poll.error} />
            ) : (
              <p className="text-sm opacity-70">Waiting for approval…</p>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        ) : flow.supportsManualPaste ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm">
              Approve access in the tab that opened, or paste the authorization code.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="connect-code">Authorization code</Label>
              <Input id="connect-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            {finish.isError && <ErrorState error={finish.error} />}
            <div className="flex gap-2">
              <Button
                disabled={code.trim().length === 0 || finish.isPending}
                onClick={() => finish.mutate()}
              >
                Connect
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm">Finish signing in in the tab that opened.</p>
            <p className="text-sm opacity-70">This dialog closes once the account is connected.</p>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
