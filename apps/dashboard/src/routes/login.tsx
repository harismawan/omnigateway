import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import styled from "styled-components";
import { useLogin, useSetup, useStatus } from "../api/queries.ts";
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

type Search = { next?: string };

function LoginScreen() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const status = useStatus();
  const login = useLogin();
  const setup = useSetup();

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const configuring = status.data?.configured === false;
  const busy = login.isPending || setup.isPending || status.isLoading;

  const goOn = () => {
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

    login.mutate(password, {
      onSuccess: goOn,
      onError: () => setProblem("That password does not match. Try again."),
    });
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

          <Stack $gap={1}>
            <Legend>{configuring ? "First run" : "Sign in"}</Legend>
            <Blurb>
              {configuring
                ? "Set the operator password for this gateway. It is the only account, and it is stored hashed."
                : "This console is for the operator of this gateway."}
            </Blurb>
          </Stack>

          <Field label="Password">
            {(props) => (
              <Input
                {...props}
                type="password"
                autoFocus
                autoComplete={configuring ? "new-password" : "current-password"}
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
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.next === "string" ? { next: search.next } : {},
  component: LoginScreen,
});
