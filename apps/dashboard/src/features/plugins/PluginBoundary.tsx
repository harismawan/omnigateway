import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import styled from "styled-components";
import { Module } from "../../ui/Panel.tsx";
import { Stack } from "../../ui/primitives.ts";

const Fault = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.color.down};
`;

const Detail = styled.p`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  overflow-wrap: anywhere;
`;

const Advice = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 68ch;
`;

export type PluginBoundaryProps = {
  pluginId: string;
  /** The plugin's display name, so the panel blames something an operator installed. */
  pluginName: string;
  children: ReactNode;
};

type PluginBoundaryState = { message: string | null };

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The plugin threw a value that is not an error.";
}

/**
 * The one thing standing between a plugin's bug and a blank console.
 *
 * Non-negotiable rather than defensive: `apps/gateway/src/app.ts` argues that
 * the console must stay up at the moment an operator needs it, and a plugin
 * that throws during an incident is exactly that moment. Everything outside
 * this boundary — the rail, the chassis, every core screen — keeps working,
 * because the failure is contained to the one panel that caused it.
 *
 * A class component because that is the only thing React lets catch a render
 * throw. It also catches the import: a bundle that 404s or fails to parse
 * rejects `React.lazy`'s promise, and a rejected lazy surfaces here rather than
 * as a suspense that never resolves.
 */
export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  override state: PluginBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): PluginBoundaryState {
    return { message: describe(error) };
  }

  /**
   * Cleared when the operator navigates to a different plugin.
   *
   * Without this the boundary is sticky: one broken plugin poisons the route it
   * shares with every other, and the second plugin renders the first one's
   * failure panel having done nothing wrong.
   */
  override componentDidUpdate(previous: PluginBoundaryProps): void {
    if (previous.pluginId !== this.props.pluginId && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Deliberately silent. React has already reported the error and its
    // component stack to the browser console, and a second copy from here would
    // only make the plugin's failure harder to read.
  }

  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;

    return (
      <Module legend="Plugin failed" meta={this.props.pluginId}>
        <Stack $gap={2}>
          <Fault>{this.props.pluginName} stopped rendering.</Fault>
          <Detail>{message}</Detail>
          <Advice>
            The rest of the console is unaffected. Reload the page to try this screen again, and
            report the message above to whoever maintains the plugin.
          </Advice>
        </Stack>
      </Module>
    );
  }
}
