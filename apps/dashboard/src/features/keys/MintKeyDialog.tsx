import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { modelsQuery, qk, useInvalidate } from "@/api/queries.ts";
import type { MintedKey, MintKeyInput } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function parseAllowlist(raw: string, known: readonly string[]) {
  const models = [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  return {
    models: models.length === 0 ? null : models,
    unknown: models.filter((model) => !known.includes(model)),
  };
}

export function MintKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const models = useQuery(modelsQuery());
  const [label, setLabel] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const mint = useMutation({
    mutationFn: (input: MintKeyInput) => api.post<MintedKey>("/api/keys", input),
    onSuccess: async (key) => {
      setMinted(key);
      await invalidate([qk.keys()]);
    },
  });
  const close = () => {
    setMinted(null);
    setLabel("");
    setAllowlist("");
    setRateLimit("");
    setUnknown([]);
    mint.reset();
    onClose();
  };
  const submit = () => {
    const parsed = parseAllowlist(
      allowlist,
      (models.data ?? []).map((model) => model.id),
    );
    setUnknown(parsed.unknown);
    if (parsed.unknown.length > 0) return;
    const parsedRateLimit = rateLimit.trim() === "" ? null : Number(rateLimit);
    mint.mutate({
      label: label.trim(),
      modelAllowlist: parsed.models,
      rateLimitPerMin: parsedRateLimit,
    });
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{minted === null ? "Mint API key" : "Copy your API key"}</DialogTitle>
        </DialogHeader>
        {minted !== null ? (
          <div className="space-y-4">
            <DialogDescription>
              This key cannot be shown again. Copy it now and store it safely.
            </DialogDescription>
            <code className="block break-all rounded bg-muted p-3 text-sm">{minted.key}</code>
            <div className="flex gap-2">
              <Button onClick={() => void navigator.clipboard?.writeText(minted.key)}>Copy</Button>
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-label">Label</Label>
              <Input
                id="key-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="key-models">Model allowlist</Label>
              <Textarea
                id="key-models"
                value={allowlist}
                onChange={(event) => setAllowlist(event.target.value)}
                placeholder="fast, smart"
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave blank to allow all models.</p>
            {unknown.length > 0 && (
              <p role="alert" className="text-sm text-warn">
                Unknown models: {unknown.join(", ")}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="key-rate-limit">Rate limit per minute</Label>
              <Input
                id="key-rate-limit"
                inputMode="numeric"
                value={rateLimit}
                onChange={(event) => setRateLimit(event.target.value)}
              />
            </div>
            {mint.isError && <ErrorState error={mint.error} />}
            <div className="flex gap-2">
              <Button disabled={mint.isPending} onClick={submit}>
                Mint key
              </Button>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
