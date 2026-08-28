import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import styled from "styled-components";
import { type LoginMode, useLogin, useSetup, useStatus } from "../api/queries.ts";
import { describeLoginReason } from "../session/reasons.ts";
import { Button } from "../ui/Button.tsx";
import { Field, Input } from "../ui/Field.tsx";
import { Lamp } from "../ui/Lamp.tsx";
import { Panel } from "../ui/Panel.tsx";
import { Legend, Row, Stack, scored } from "../ui/primitives.ts";
import { describeError } from "../ui/States.tsx";

const Screen = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: ${({ theme }) => theme.space(4)};
`;

const Card = styled(Panel)`
  width: min(380px, 100%);
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: ${({ theme }) => `${theme.space(3)} ${theme.space(4)}`};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};
  ${scored}
  font-stretch: 74%;
  font-weight: 700;
  letter-spacing: 0.2em;
  font-size: 12px;
  text-transform: uppercase;
`;

const Body = styled.form`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(3)};
  padding: ${({ theme }) => theme.space(4)};
`;

const Blurb = styled.p`
  font-size: 12.5px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

/**
 * Why the session ended, when the console knows.
 *
 * Warn rather than down: nothing failed, and being asked to sign in again after
 * restoring a database that carries a different password is the system working.
 */
const Ended = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

/** Which credential the form is asking for. */
const Tab = styled.button<{ $on?: boolean }>`
  border: 1px solid ${({ theme, $on }) => ($on === true ? theme.color.accent : theme.color.rule)};
  background: ${({ theme, $on }) => ($on === true ? theme.color.accentWash : "transparent")};
  color: ${({ theme, $on }) => ($on === true ? theme.color.ink : theme.color.inkDim)};
  border-radius: ${({ theme }) => theme.radius.control};
  padding: ${({ theme }) => theme.space(1)} ${({ theme }) => theme.space(2)};
  font: inherit;
  font-size: 12px;
  cursor: pointer;
`;

type Search = { next?: string; reason?: string };

function LoginScreen() {
  const navigate = useNavigate();
  const { next, reason } = Route.useSearch();
  const status = useStatus();
  const login = useLogin();
  const setup = useSetup();

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<LoginMode>("admin");

  const configuring = status.data?.configured === false;
  /**
   * Which credentials this gateway will accept.
   *
   * The read-only option appears only where a password has been set, because an
   * option that always refuses is one a reader assumes is broken rather than
   * switched off. The client option is always there: any minted key opens it,
   * and there is no server-side flag that could say otherwise.
   */
  const modes: ReadonlyArray<{ id: LoginMode; label: string; blurb: string }> = [
    { id: "admin", label: "Operator", blurb: "This console is for the operator of this gateway." },
    ...(status.data?.viewerConfigured === true
      ? [
          {
            id: "viewer" as const,
            label: "Read-only",
            blurb: "Everything the operator can see, and nothing they can change.",
          },
        ]
      : []),
    {
      id: "client" as const,
      label: "API key",
      blurb: "Your own usage, limits and requests. Sign in with a gateway API key.",
    },
  ];
  const client = mode === "client";
  // Why the operator is here, when the console sent them rather than the cookie
  // simply expiring. Unknown codes describe nothing, so nothing is shown.
  const ended = describeLoginReason(reason);
  const busy = login.isPending || setup.isPending || status.isLoading;

  const goOn = () => {
    // A client session has no console to return to, so `next` is ignored for it
    // — honouring a saved `/usage` would land it on a screen its own gate
    // immediately bounces it off, which reads as a redirect loop.
    if (client) {
      void navigate({ to: "/client" });
      return;
    }
    // Only a same-origin path is honoured; anything else lands on the rack.
    void navigate({ to: next?.startsWith("/") === true ? next : "/" });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);

    if (configuring) {
      if (password !== confirmation) {
        setProblem("The two passwords do not match.");
        return;
      }
      setup.mutate(password, {
        onSuccess: goOn,
        onError: (error) => setProblem(describeError(error)),
      });
      return;
    }

    login.mutate(
      { mode, secret: password },
      {
        onSuccess: goOn,
        onError: () =>
          setProblem(
            client
              ? "That API key was not accepted. It may have been revoked."
              : "That password does not match. Try again.",
          ),
      },
    );
  };

  return (
    <Screen>
      <Card>
        <Head>
          <Lamp
            state={status.isError ? "down" : "ok"}
            label={status.isError ? "gateway unreachable" : "gateway reachable"}
          />
          Omnigateway
        </Head>
        <Body onSubmit={submit}>
          {status.isError ? (
            <Problem>The gateway is not answering. Check that it is running, then reload.</Problem>
          ) : null}

          {ended === null ? null : <Ended role="status">{ended}</Ended>}

          <Stack $gap={1}>
            <Legend>{configuring ? "First run" : "Sign in"}</Legend>
            <Blurb>
              {configuring
                ? "Set the operator password for this gateway. It is the only account, and it is stored hashed."
                : (modes.find((entry) => entry.id === mode)?.blurb ?? "")}
            </Blurb>
          </Stack>

          {/*
            Hidden during first run: there is no operator password yet, so there
            is nothing for a read-only or key holder to sign in beside.
          */}
          {configuring || modes.length < 2 ? null : (
            <Row $gap={1} $wrap role="tablist" aria-label="Sign in as">
              {modes.map((entry) => (
                <Tab
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={entry.id === mode}
                  $on={entry.id === mode}
                  onClick={() => {
                    setMode(entry.id);
                    // The field means something different per mode, so carrying
                    // a typed password into the key field would offer to submit
                    // one credential to the other's endpoint.
                    setPassword("");
                    setProblem(null);
                  }}
                >
                  {entry.label}
                </Tab>
              ))}
            </Row>
          )}

          <Field label={client ? "API key" : "Password"}>
            {(props) => (
              <Input
                {...props}
                type="password"
                autoFocus
                autoComplete={configuring ? "new-password" : client ? "off" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>

          {configuring ? (
            <Field label="Confirm password">
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              )}
            </Field>
          ) : null}

          {problem === null ? null : <Problem role="alert">{problem}</Problem>}

          <Row>
            <Button type="submit" $variant="primary" disabled={busy || password.length === 0}>
              {configuring ? "Set password and sign in" : "Sign in"}
            </Button>
          </Row>
        </Body>
      </Card>
    </Screen>
  );
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(typeof search.reason === "string" ? { reason: search.reason } : {}),
  }),
  component: LoginScreen,
});
