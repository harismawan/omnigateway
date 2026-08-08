import { useId } from "react";
import styled from "styled-components";

const Svg = styled.svg`
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
`;

export type SparklineProps = {
  values: readonly number[];
  /** Drawn under the main trace in the fault colour, e.g. errors under traffic. */
  overlay?: readonly number[];
  height?: number;
  color?: string;
  overlayColor?: string;
  /**
   * Scale the y-axis to this value instead of the series' own peak. Use it when
   * a trace is only meaningful against another one — an error count drawn to
   * its own maximum turns two failures into a full-height alarm.
   */
  scaleTo?: number;
  /** Text alternative; the trace itself is decorative once this is read. */
  label: string;
  className?: string;
};

function path(values: readonly number[], width: number, height: number, max: number): string {
  if (values.length === 0) return "";
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map((value, i) => {
      const x = i * step;
      const y = height - (max === 0 ? 0 : (value / max) * height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * A fixed-viewBox trace scaled to its box. The x-axis is time, oldest at the
 * left; the y-axis is scaled to the window's own peak, so the shape reads as
 * "what changed recently" rather than as an absolute magnitude.
 */
export function Sparkline({
  values,
  overlay,
  height = 28,
  color,
  overlayColor,
  scaleTo,
  label,
  className,
}: SparklineProps) {
  const gradientId = useId();
  const width = 100;
  const max =
    scaleTo === undefined ? Math.max(1, ...values, ...(overlay ?? [])) : Math.max(1, scaleTo);
  const trace = path(values, width, height, max);
  const fill = trace.length === 0 ? "" : `${trace} L${width},${height} L0,${height} Z`;

  return (
    <Svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color ?? "var(--accent)"} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color ?? "var(--accent)"} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill.length === 0 ? null : <path d={fill} fill={`url(#${gradientId})`} />}
      {overlay === undefined ? null : (
        <path
          d={path(overlay, width, height, max)}
          fill="none"
          stroke={overlayColor ?? "var(--down)"}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={trace}
        fill="none"
        stroke={color ?? "var(--accent)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}
