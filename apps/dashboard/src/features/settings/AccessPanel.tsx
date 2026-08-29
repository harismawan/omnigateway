import { useState } from "react";
import styled from "styled-components";
import { useChangePassword, useSetViewerPassword, useStatus } from "../../api/queries.ts";
import { endAdminSession } from "../../session/reasons.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, Input } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Row, Stack } from "../../ui/primitives.ts";
import { describeError } from "../../ui/States.tsx";

/**
 * The gateway's own rule, restated so the form can say it before the round
 * trip. The server checks it too — this is a courtesy, never the guard.
 */
const MIN_PASSWORD_LENGTH = 12;

const Blurb = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 62ch;
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Saved = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

const Narrow = styled(Input)`
  width: 260px;
`;

/**
 * Changing the operator's own password.
 *
 * The current password is asked for because the session cookie is not enough on
 * its own: an admin session may be a browser left open, and a cookie that could
 * rewrite the credential behind it turns that into a lockout. The gateway
 * enforces this; the form merely collects it.
 */
function AdminPassword() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setProblem("The two new passwords do not match.");
      return;
    }
    setProblem(null);
    change.mutate(
      { current, password: next },
      {
        // Every session ends server-side, this one included, so there is
        // nothing left to render here. Leaving the operator on a console whose
        // cookie is already dead would fail on the next read instead of saying
        // what happened.
        onSuccess: () => endAdminSession("password-changed"),
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  return (
    <Stack $gap={2}>
      <Blurb>
        Changing this signs every session out, including this one, and you will be asked to sign in
        again with the new password.
      </Blurb>
      <Row $gap={2} $wrap $align="end">
        <Field label="Current password">
          {(props) => (
            <Narrow
              {...props}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          )}
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(props) => (
            <Narrow
              {...props}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          )}
        </Field>
        <Field label="Repeat new password">
          {(props) => (
            <Narrow
              {...props}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </Field>
        <Button
          type="button"
          $variant="primary"
          onClick={submit}
          disabled={change.isPending || current.length === 0 || next.length === 0}
        >
          Change password
        </Button>
      </Row>
      {problem === null ? null : <Problem role="alert">{problem}</Problem>}
    </Stack>
  );
}

/**
 * The read-only password, which is optional and has an off.
 *
 * There is no default and never has been: with none set, no password opens a
 * read-only session, and the login screen does not offer the mode at all. That
 * is why this panel says "not set" rather than leaving the field blank and
 * letting an operator wonder what the blank means.
 */
function ViewerPassword() {
  const status = useStatus();
  const set = useSetViewerPassword();
  const [next, setNext] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const configured = status.data?.viewerConfigured === true;

  const save = () => {
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setProblem(null);
    set.mutate(next, {
      onSuccess: () => {
        setNext("");
        setDone(configured ? "Read-only password replaced." : "Read-only access granted.");
      },
      onError: (error) => setProblem(describeError(error)),
    });
  };

  const withdraw = () => {
    setProblem(null);
    set.mutate(null, {
      onSuccess: () => setDone("Read-only access withdrawn."),
      onError: (error) => setProblem(describeError(error)),
    });
  };

  return (
    <Stack $gap={2}>
      <Blurb>
        A second password that signs in to a read-only console: every screen the operator sees,
        without mutations, snapshot downloads, or request bodies. Hand it to someone who needs to
        watch this gateway without being able to change it.{" "}
        {status.isPending
          ? "Reading whether one is set…"
          : configured
            ? "One is set. Entering a new one replaces it; withdrawing it ends any read-only session immediately."
            : "None is set, so nobody can sign in read-only. There is no default password."}
      </Blurb>
      <Row $gap={2} $wrap $align="end">
        <Field
          label={configured ? "Replace read-only password" : "Set read-only password"}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        >
          {(props) => (
            <Narrow
              {...props}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          )}
        </Field>
        <Button
          type="button"
          $variant="primary"
          onClick={save}
          disabled={set.isPending || next.length === 0}
        >
          {configured ? "Replace" : "Set"}
        </Button>
        {configured ? (
          <Button type="button" $variant="danger" onClick={withdraw} disabled={set.isPending}>
            Withdraw access
          </Button>
        ) : null}
      </Row>
      {problem === null ? null : <Problem role="alert">{problem}</Problem>}
      {done === null || problem !== null ? null : <Saved role="status">{done}</Saved>}
    </Stack>
  );
}

/** Who may sign in to this console, and with what. */
export function AccessPanel() {
  return (
    <Module legend="Access">
      <Stack $gap={4}>
        <AdminPassword />
        <ViewerPassword />
      </Stack>
    </Module>
  );
}
