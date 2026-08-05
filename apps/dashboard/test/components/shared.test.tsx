import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { DataTableFrame } from "../../src/components/DataTableFrame.tsx";
import { EmptyState } from "../../src/components/EmptyState.tsx";
import { ErrorState } from "../../src/components/ErrorState.tsx";
import { LoadingSkeleton } from "../../src/components/LoadingSkeleton.tsx";
import { PageHeader } from "../../src/components/PageHeader.tsx";
import { StatTile } from "../../src/components/StatTile.tsx";
import { StatusBadge } from "../../src/components/StatusBadge.tsx";

test("PageHeader renders page title and supplied actions", () => {
  render(
    <PageHeader
      title="Credentials"
      description="Manage provider accounts."
      actions={<button type="button">Connect provider</button>}
    />,
  );

  expect(screen.getByRole("heading", { level: 1, name: "Credentials" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Connect provider" })).toBeDefined();
});

test("StatusBadge renders an icon alongside its status label", () => {
  render(<StatusBadge label="Rate limited" tone="warn" />);

  const status = screen.getByText("Rate limited");
  expect(status.closest("span")?.querySelector("svg, [aria-hidden=true]")).not.toBeNull();
});

test("StatTile groups metric value with its label", () => {
  render(<StatTile label="Requests" value="1,240" detail="Last 24 hours" />);

  expect(within(screen.getByRole("group", { name: "Requests" })).getByText("1,240")).toBeDefined();
});

test("EmptyState renders supplied action", () => {
  render(
    <EmptyState
      title="No models"
      description="Create a virtual model."
      action={<button type="button">Create model</button>}
    />,
  );

  expect(screen.getByRole("button", { name: "Create model" })).toBeDefined();
});

test("DataTableFrame exposes named region when label supplied", () => {
  render(
    <DataTableFrame ariaLabel="Credentials table">
      <table>
        <tbody>
          <tr>
            <td>Example</td>
          </tr>
        </tbody>
      </table>
    </DataTableFrame>,
  );

  expect(screen.getByRole("region", { name: "Credentials table" })).toBeDefined();
});

test("LoadingSkeleton hides decorative placeholder from assistive technology", () => {
  const { container } = render(<LoadingSkeleton />);

  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});

test("ErrorState renders alert icon and retry action", () => {
  render(<ErrorState error={new Error("Request failed")} onRetry={() => undefined} />);

  const alert = screen.getByRole("alert");
  expect(alert.querySelector("svg, [aria-hidden=true]")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
});
