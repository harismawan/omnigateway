import { expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { BodyArtifact } from "../../src/features/logs/BodyArtifact.tsx";
import { invalidateTopic } from "../../src/session/invalidation.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { requestBody } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

test("mounted pending body becomes ready without log churn, then stops polling", async () => {
  let ready = false;
  let reads = 0;
  createFetchStub({
    "GET /api/requests/r/body": () => {
      reads++;
      return ready
        ? requestBody({ requestId: "r" })
        : requestBody({
            requestId: "r",
            bodyState: "pending",
            detailState: "none",
            artifact: null,
          });
    },
  });
  const view = renderWithProviders(<BodyArtifact requestId="r" />);
  expect(await screen.findByText("Capture pending")).toBeTruthy();
  expect(screen.queryByText("Not captured")).toBeNull();
  ready = true;
  await waitFor(
    () => expect(screen.getByRole("heading", { name: "Request from the client" })).toBeTruthy(),
    { timeout: 3000 },
  );
  const terminalReads = reads;
  invalidateTopic(view.client, "res:logs");
  await Bun.sleep(1200);
  expect(reads).toBe(terminalReads);
  view.unmount();
});

test("failed capture is distinct from not attempted and does not poll", async () => {
  let reads = 0;
  createFetchStub({
    "GET /api/requests/r/body": () => {
      reads++;
      return requestBody({
        requestId: "r",
        bodyState: "failed",
        detailState: "none",
        artifact: null,
      });
    },
  });
  const view = renderWithProviders(<BodyArtifact requestId="r" />);
  expect(await screen.findByText("Capture failed")).toBeTruthy();
  expect(screen.queryByText("Not captured")).toBeNull();
  await Bun.sleep(1200);
  expect(reads).toBe(1);
  view.unmount();
});

test("unmounting a pending panel stops polling", async () => {
  let reads = 0;
  createFetchStub({
    "GET /api/requests/r/body": () => {
      reads++;
      return requestBody({
        requestId: "r",
        bodyState: "pending",
        detailState: "none",
        artifact: null,
      });
    },
  });
  const view = renderWithProviders(<BodyArtifact requestId="r" />);
  await waitFor(() => expect(reads).toBe(1));
  view.unmount();
  await Bun.sleep(1200);
  expect(reads).toBe(1);
});
