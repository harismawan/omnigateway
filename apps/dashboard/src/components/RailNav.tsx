import { Link } from "@tanstack/react-router";
import {
  Activity,
  Blocks,
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
import { usePlugins } from "../api/queries.ts";
import { pluginNavEntries, pluginPath } from "../features/plugins/catalog.ts";

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
    blurb: "Size, snapshots, restart and shutdown",
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

/**
 * A plugin whose interface this console cannot load.
 *
 * A button rather than a styled link, so that "cannot be followed" is carried
 * by the element itself: a disabled button is unreachable by keyboard and by
 * pointer without a handler that has to remember to refuse. A link with an
 * `aria-disabled` attribute still navigates.
 */
const Blocked = styled.button`
  ${face}
  align-items: flex-start;
  width: 100%;
  text-align: left;
  white-space: normal;
  background: none;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  color: ${({ theme }) => theme.color.inkFaint};
  cursor: not-allowed;
  font-family: inherit;

  svg {
    margin-top: 2px;
  }
`;

const BlockedLines = styled.span`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

const Reason = styled.span`
  font-size: 10.5px;
  font-weight: 400;
  line-height: 1.3;
  color: ${({ theme }) => theme.color.warn};
`;

export function RailNav() {
  // A rail that renders nothing until the catalog answers would flicker on every
  // navigation, so the core entries are drawn immediately and plugins arrive
  // when they do. A failed request leaves the console entirely usable.
  const plugins = usePlugins();

  return (
    <Rail aria-label="Console sections">
      {DESTINATIONS.map(({ to, label, blurb, Icon }) => (
        <Item key={to} to={to} title={blurb} activeOptions={{ exact: to === "/" }}>
          <Icon />
          {label}
        </Item>
      ))}
      {pluginNavEntries(plugins.data ?? []).map(({ id, label, disabledReason }) =>
        disabledReason === null ? (
          <Item key={id} to={pluginPath(id)} title={`Provided by the ${id} plugin`}>
            <Blocks />
            {label}
          </Item>
        ) : (
          <Blocked key={id} type="button" disabled>
            <Blocks />
            <BlockedLines>
              {label}
              <Reason>{disabledReason}</Reason>
            </BlockedLines>
          </Blocked>
        ),
      )}
    </Rail>
  );
}
