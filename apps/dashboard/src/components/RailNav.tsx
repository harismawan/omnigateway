import { Link } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Cable,
  Database,
  Gauge,
  KeyRound,
  ScrollText,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import type { ComponentType } from "react";
import styled, { css } from "styled-components";
import { LifecycleControls } from "./LifecycleControls.tsx";

type Destination = {
  to: string;
  label: string;
  /** One line, in the operator's vocabulary, shown as the link's title. */
  blurb: string;
  Icon: ComponentType<{ className?: string }>;
};

/** Order follows how a gateway is actually set up, then how it is watched. */
const DESTINATIONS: Destination[] = [
  { to: "/", label: "Rack", blurb: "Live state of every account and model", Icon: Activity },
  {
    to: "/accounts",
    label: "Accounts",
    blurb: "Provider credentials and their health",
    Icon: Cable,
  },
  { to: "/models", label: "Models", blurb: "Virtual models, targets, and routing", Icon: Boxes },
  { to: "/keys", label: "Keys", blurb: "Gateway API keys and their limits", Icon: KeyRound },
  { to: "/usage", label: "Usage", blurb: "Requests, tokens, and spend over time", Icon: Gauge },
  { to: "/logs", label: "Logs", blurb: "Recent requests, one row each", Icon: ScrollText },
  {
    to: "/console",
    label: "Console",
    blurb: "The gateway's own output, as it was printed",
    Icon: Terminal,
  },
  {
    to: "/settings",
    label: "Settings",
    blurb: "Routing weights, retries, retention",
    Icon: SlidersHorizontal,
  },
  {
    to: "/database",
    label: "Database",
    blurb: "Size, snapshots, and retention",
    Icon: Database,
  },
];

const Rail = styled.nav`
  grid-area: rail;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: ${({ theme }) => theme.space(2)};
  border-right: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panel};
  overflow-y: auto;

  @media (max-width: 720px) {
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  }
`;

/** The face every rail entry wears, whether or not it can be followed. */
const face = css`
  display: flex;
  align-items: center;
  line-height: 1;
  gap: ${({ theme }) => theme.space(2)};
  padding: 7px ${({ theme }) => theme.space(2)};
  border-radius: ${({ theme }) => theme.radius.control};
  border-left: 2px solid transparent;
  color: ${({ theme }) => theme.color.inkDim};
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background 120ms ease,
    color 120ms ease;

  svg {
    width: 15px;
    height: 15px;
    flex: none;
    transform: translateY(-1px);
  }
`;

const Item = styled(Link)`
  ${face}

  &:hover {
    background: ${({ theme }) => theme.color.panelSunk};
    color: ${({ theme }) => theme.color.ink};
  }

  &[data-status="active"] {
    background: ${({ theme }) => theme.color.accentWash};
    border-left-color: ${({ theme }) => theme.color.accent};
    color: ${({ theme }) => theme.color.accent};
  }
`;

export function RailNav() {
  return (
    <Rail aria-label="Console sections">
      {DESTINATIONS.map(({ to, label, blurb, Icon }) => (
        <Item key={to} to={to} title={blurb} activeOptions={{ exact: to === "/" }}>
          <Icon />
          {label}
        </Item>
      ))}
      <LifecycleControls />
    </Rail>
  );
}
