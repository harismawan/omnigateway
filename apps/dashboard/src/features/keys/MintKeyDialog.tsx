import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { modelsQuery, qk, useInvalidate } from "@/api/queries.ts";
import type { MintedKey, MintKeyInput } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
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

export function MintKeyDialog({
  onClose,
  onCloseAutoFocus,
}: {
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const invalidate = useInvalidate();
  const models = useQuery(modelsQuery());
  const [label, setLabel] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const mint = useMutation({
    mutationFn: async (input: MintKeyInput) => {
      setMinted(await api.post<MintedKey>("/api/keys", input));
    },
    onSuccess: async () => {
      await invalidate([qk.keys()]);
    },
  });
  const close = () => {
    setMinted(null);
    setLabel("");
    setAllowlist("");
    setRateLimit("");
    setUnknown([]);
    setLocalError(null);
    setCopyError(false);
    setCopied(false);
    mint.reset();
    onClose();
  };
  const submit = () => {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) {
      setLocalError("Label is required.");
      return;
    }
    const parsed = parseAllowlist(
      allowlist,
      (models.data ?? []).map((model) => model.id),
    );
    setUnknown(parsed.unknown);
    if (parsed.unknown.length > 0) return;
    const parsedRateLimit = rateLimit.trim() === "" ? null : Number(rateLimit);
    if (parsedRateLimit !== null && (!Number.isInteger(parsedRateLimit) || parsedRateLimit < 1)) {
      setLocalError("Rate limit must be a positive whole number.");
      return;
    }
    setLocalError(null);
    mint.mutate({
      label: trimmedLabel,
      modelAllowlist: parsed.models,
      rateLimitPerMin: parsedRateLimit,
    });
  };
  const copy = async () => {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setCopied(false);
      setCopyError(true);
      return;
    }
    try {
      await clipboard.writeText(minted?.key ?? "");
      setCopyError(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };
  return (
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader>
        <DialogTitle>{minted === null ? "Mint API key" : "Copy your API key"}</DialogTitle>
      </DialogHeader>
      {minted !== null ? (
        <div className="space-y-4">
          <DialogDescription>
            This key cannot be shown again. Copy it now and store it safely.
          </DialogDescription>
          <Input
            aria-label="New API key"
            className="font-mono text-xs"
            readOnly
            value={minted.key}
            onFocus={(event) => event.currentTarget.select()}
          />
          {copyError && (
            <p role="alert" className="text-sm text-warn">
              Could not copy key; select and copy it manually.
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            <Button variant="secondary" onClick={close}>
              I saved this key
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
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.value)}
            />
          </div>
          {localError !== null && (
            <p role="alert" className="text-sm text-warn">
              {localError}
            </p>
          )}
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
  );
}
