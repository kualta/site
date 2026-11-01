import { useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { VideoIcon } from "@/components/icons";
import {
  dayTicks,
  groupMarks,
  platformColor,
  reportingPlatforms,
  stackExtent,
  stackOrder,
  timeTicks,
  valueTicks,
  type SeriesPoint,
  type VideoMark,
} from "@/lib/publisher/metrics";
import { platformNames } from "@/lib/publisher/presets";

const HOUR = 3_600_000;
const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const whole = new Intl.NumberFormat();
const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fullDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const axisText = { fill: "var(--secondary-text)", fontSize: 12 };

type Hovered = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SeriesPoint }>;
  label?: string;
  when: Intl.DateTimeFormat;
};
function Readout({ active, payload, label, when }: Hovered) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const reporting = reportingPlatforms(point);
  return (
    <div className="publisher-chart-tooltip">
      <strong>{whole.format(point.value)}</strong>
      <span>{label}</span>
      {reporting.length > 1 && (
        <ul>
          {reporting.map((platform) => (
            <li key={platform}>
              <i style={{ background: platformColor(platform) }} />
              <b>{whole.format(point.parts[platform]!)}</b>
              <span>{platformNames[platform]}</span>
            </li>
          ))}
        </ul>
      )}
      <small>{when.format(point.at)}</small>
    </div>
  );
}

function Thumbnail({ mark }: { mark: VideoMark }) {
  const [failed, setFailed] = useState(false);
  if (!mark.thumbnail || failed) return <VideoIcon size={14} />;
  return <img src={mark.thumbnail} alt="" loading="lazy" onError={() => setFailed(true)} />;
}
function cardSide(left: number) {
  if (left < 25) return "start";
  return left > 75 ? "end" : "middle";
}
type MarkActions = { canOpen: (id: string) => boolean; onOpen: (id: string) => void };
/** Sits between the axis line and its dates. Its CSS inset matches the Y axis width and right margin, lining it up with the plot. */
function VideoMarks({ marks, span, canOpen, onOpen }: MarkActions & { marks: VideoMark[]; span: [number, number] }) {
  return (
    <div className="publisher-chart-marks">
      {groupMarks(marks, span).map((group) => {
        const left = ((group[0].at - span[0]) / (span[1] - span[0])) * 100;
        const lone = group.length === 1 ? group[0] : null;
        return (
          <div
            key={group[0].id}
            className="publisher-chart-mark"
            style={{ left: `${left}%` }}
            data-side={cardSide(left)}
          >
            <button
              type="button"
              aria-label={`${lone ? "Video" : `${group.length} videos`} posted: ${group
                .map((m) => m.label)
                .join(", ")}`}
              onClick={() => lone && canOpen(lone.id) && onOpen(lone.id)}
            >
              <Thumbnail mark={group.find((mark) => mark.thumbnail) ?? group[0]} />
              {!lone && <small>{group.length}</small>}
            </button>
            <div className="publisher-chart-mark-card">
              {group.map((mark) => (
                <button key={mark.id} type="button" disabled={!canOpen(mark.id)} onClick={() => onOpen(mark.id)}>
                  <Thumbnail mark={mark} />
                  <span>
                    <strong>{mark.label}</strong>
                    <small>{fullTime.format(mark.at)}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const AXIS_WITH_MARKS = { height: 62, tickMargin: 36 };
/** More bars than this and their totals would run into each other. */
const MOST_LABELED_BARS = 10;

type Segment = { x?: number; y?: number; width?: number; height?: number; fill?: string };
/** Leaves the 2px gap above a segment that can spare it, and keeps the thinnest visible as a sliver. */
function BarSegment({ x = 0, y = 0, width = 0, height = 0, fill }: Segment) {
  const size = Math.abs(height);
  if (!size) return <g />;
  const gap = size > 4 ? 2 : 0;
  return (
    <rect
      x={x}
      y={Math.min(y, y + height) + gap}
      width={width}
      height={Math.max(size - gap, 1.5)}
      rx={1.5}
      fill={fill}
    />
  );
}

/**
 * A running total draws as a line: monotone interpolation curves between observations without ever overshooting them,
 * so it can't invent a dip or a peak. Separate days (`bars`) draw as bars, since nothing was measured between them.
 */
export default function PublisherTrendChart({
  points,
  label,
  marks = [],
  bars = false,
  canOpen = () => false,
  onOpen = () => {},
}: { points: SeriesPoint[]; label: string; marks?: VideoMark[]; bars?: boolean } & Partial<MarkActions>) {
  const first = Math.min(points[0].at, marks[0]?.at ?? Infinity);
  const last = Math.max(points.at(-1)!.at, marks.at(-1)?.at ?? 0);
  // A bar, or a lone observation, needs room either side of it.
  const padding = bars || first === last ? 12 * HOUR : 0;
  const span: [number, number] = [first - padding, last + padding];
  const dates = bars || span[1] - span[0] > 48 * HOUR ? dayLabel : timeLabel;
  let ticks = timeTicks(...span);
  if (bars) ticks = dayTicks(points);
  else if (first === last) ticks = [first];
  const extents = points.map(stackExtent);
  const lowest = Math.min(...extents.map((e) => e.low));
  const values = valueTicks(Math.max(...extents.map((e) => e.high)), lowest);
  // A platform stuck at zero has nothing to draw, and its gap would only cut through its neighbor.
  const bands = stackOrder.filter((platform) => points.some((point) => (point.parts[platform] ?? 0) !== 0));
  // A band needs a height at every point or it isn't drawn at all, so it's zero until its platform first reports.
  // Only the drawing sees these zeros: the readout and key use `parts`, which leave unreported counts out.
  const stacked = useMemo(
    () =>
      points.map((point) => ({
        ...point,
        top: stackExtent(point).high,
        heights: Object.fromEntries(stackOrder.map((platform) => [platform, point.parts[platform] ?? 0])),
      })),
    [points],
  );
  return (
    <>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
        {/* Recharts stacks in mount order, so a new set of bands starts over to keep the fixed order. */}
        <ComposedChart
          key={`${bars}:${bands.join()}`}
          data={stacked}
          stackOffset={bars ? "sign" : "none"}
          margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--publisher-line)" />
          <XAxis
            dataKey="at"
            type="number"
            scale="time"
            domain={span}
            ticks={ticks}
            tickFormatter={(at: number) => dates.format(at)}
            tick={axisText}
            tickLine={false}
            axisLine={{ stroke: "var(--publisher-line)" }}
            minTickGap={32}
            {...(marks.length ? AXIS_WITH_MARKS : {})}
          />
          <YAxis
            domain={[Math.min(values[0], lowest), values.at(-1)!]}
            ticks={values}
            tickFormatter={(value: number) => compact.format(value)}
            tick={axisText}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: "currentColor", strokeOpacity: 0.35 }}
            isAnimationActive={false}
            content={(hovered) => <Readout {...hovered} label={label} when={bars ? fullDay : fullTime} />}
          />
          {bars
            ? bands.map((platform) => (
                <Bar
                  key={platform}
                  stackId="platforms"
                  dataKey={`heights.${platform}`}
                  fill={platformColor(platform)}
                  shape={BarSegment}
                  maxBarSize={24}
                  isAnimationActive={false}
                />
              ))
            : bands.map((platform) => (
                <Area
                  key={platform}
                  type="monotone"
                  stackId="platforms"
                  dataKey={`heights.${platform}`}
                  fill={platformColor(platform)}
                  fillOpacity={1}
                  stroke="var(--publisher-page)"
                  strokeWidth={2}
                  activeDot={false}
                  isAnimationActive={false}
                />
              ))}
          {bars && points.length <= MOST_LABELED_BARS && (
            <Line dataKey="top" stroke="none" dot={false} activeDot={false} isAnimationActive={false}>
              <LabelList
                dataKey="value"
                position="top"
                offset={8}
                formatter={(value) => whole.format(Number(value))}
                {...axisText}
              />
            </Line>
          )}
          {!bars && (
            <Line
              type="monotone"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={points.length <= 24 ? { r: 3, fill: "currentColor", stroke: "none" } : false}
              activeDot={{ r: 4, fill: "currentColor", stroke: "var(--publisher-page)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      {!!marks.length && <VideoMarks marks={marks} span={span} canOpen={canOpen} onOpen={onOpen} />}
    </>
  );
}
