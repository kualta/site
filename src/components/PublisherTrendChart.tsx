import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { timeTicks, valueTicks, type SeriesPoint } from "@/lib/publisher/metrics";

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
const axisText = { fill: "var(--secondary-text)", fontSize: 12 };

type Hovered = { active?: boolean; payload?: ReadonlyArray<{ payload?: SeriesPoint }>; label?: string };
function Readout({ active, payload, label }: Hovered) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="publisher-chart-tooltip">
      <strong>{whole.format(point.value)}</strong>
      <span>{label}</span>
      <small>
        {fullTime.format(point.at)} · {point.coverage} {point.coverage === 1 ? "source" : "sources"}
      </small>
    </div>
  );
}

/** Monotone interpolation curves between observations without ever overshooting them, so the line can't invent a dip or a peak. */
export default function PublisherTrendChart({ points, label }: { points: SeriesPoint[]; label: string }) {
  const first = points[0].at;
  const last = points.at(-1)!.at;
  // A lone observation still needs room either side of it.
  const span: [number, number] = first === last ? [first - 12 * HOUR, last + 12 * HOUR] : [first, last];
  const dates = span[1] - span[0] > 48 * HOUR ? dayLabel : timeLabel;
  const values = valueTicks(Math.max(...points.map((point) => point.value)));
  return (
    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
      <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--publisher-line)" />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={span}
          ticks={first === last ? [first] : timeTicks(...span)}
          tickFormatter={(at: number) => dates.format(at)}
          tick={axisText}
          tickLine={false}
          axisLine={{ stroke: "var(--publisher-line)" }}
          minTickGap={32}
        />
        <YAxis
          domain={[0, values.at(-1)!]}
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
          content={(hovered) => <Readout {...hovered} label={label} />}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="currentColor"
          fillOpacity={0.1}
          dot={points.length <= 24 ? { r: 3, fill: "currentColor", stroke: "none", fillOpacity: 1 } : false}
          activeDot={{ r: 4, fill: "currentColor", stroke: "var(--publisher-surface)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
