import type { ReactNode } from "react";
import styled from "styled-components";
import { Legend, Spacer } from "../ui/primitives.ts";
import { ChassisBar } from "./ChassisBar.tsx";
import { RailNav } from "./RailNav.tsx";

const Frame = styled.div`
  display: grid;
  grid-template-areas:
    "chassis chassis"
    "rail main";
  grid-template-columns: 168px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 100%;

  @media (max-width: 720px) {
    grid-template-areas:
      "chassis"
      "rail"
      "main";
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
  }
`;

const Main = styled.main`
  grid-area: main;
  padding: ${({ theme }) => theme.space(4)};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(4)};
  min-width: 0;

  @media (max-width: 720px) {
    padding: ${({ theme }) => theme.space(3)};
  }
`;

export function Rack({ children }: { children: ReactNode }) {
  return (
    <Frame>
      <ChassisBar />
      <RailNav />
      <Main>{children}</Main>
    </Frame>
  );
}

const HeadRow = styled.div`
  display: flex;
  align-items: flex-end;
  gap: ${({ theme }) => theme.space(3)};
  flex-wrap: wrap;
`;

const Title = styled.h1`
  font-size: 20px;
  font-weight: 600;
  font-stretch: 88%;
  letter-spacing: -0.01em;
`;

const Summary = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 68ch;
`;

const Head = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
`;

export type PageHeadProps = {
  legend: string;
  title: string;
  /** One plain sentence about what this screen is for or what it currently says. */
  summary: string;
  actions?: ReactNode;
};

export function PageHead({ legend, title, summary, actions }: PageHeadProps) {
  return (
    <HeadRow>
      <Head>
        <Legend>{legend}</Legend>
        <Title>{title}</Title>
        <Summary>{summary}</Summary>
      </Head>
      <Spacer />
      {actions}
    </HeadRow>
  );
}
