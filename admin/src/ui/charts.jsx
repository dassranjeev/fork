import React from "react";
import ReactApexChart from "react-apexcharts";
import { chartSafe } from "../lib/safe";

export const PALETTE = ["#f95a16", "#487fff", "#22c55e", "#8b5cf6", "#eab308", "#06b6d4", "#ef4444", "#64748b"];

const base = (height, extra = {}) => ({
  chart: { toolbar: { show: false }, height, fontFamily: "inherit", animations: { enabled: true }, ...extra.chart },
  colors: extra.colors || PALETTE,
  dataLabels: { enabled: false },
  grid: { borderColor: "rgba(120,120,120,.18)", strokeDashArray: 4 },
  legend: { position: "top", horizontalAlign: "right" },
  tooltip: { theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light" },
  ...extra.rest,
});

/**
 * Line / area chart.
 *  series: [{ name, data: [{x:'2026-01-01', y: 10}, ...] }]  (or data: number[] with `categories`)
 */
export function LineChart({ series: rawSeries, categories: rawCategories, height = 300, area = true, currency, stacked, colors, yFormatter }) {
  const series = chartSafe(rawSeries);
  const categories = chartSafe(rawCategories);
  const fmt = yFormatter || (currency ? (v) => `$${Number(v).toLocaleString("en-CA", { maximumFractionDigits: 0 })}` : (v) => Number(v).toLocaleString("en-CA", { maximumFractionDigits: 1 }));
  const options = {
    ...base(height, { colors, chart: { type: area ? "area" : "line", stacked } }),
    stroke: { curve: "smooth", width: 2.5 },
    fill: area ? { type: "gradient", gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.02 } } : { opacity: 1 },
    xaxis: categories ? { categories } : { type: "category", labels: { rotate: 0, hideOverlappingLabels: true } },
    yaxis: { labels: { formatter: fmt } },
    markers: { size: 0, hover: { size: 5 } },
  };
  return <ReactApexChart options={options} series={series} type={area ? "area" : "line"} height={height} />;
}

/** Bar / column chart. horizontal for ranked lists. */
export function BarChart({ series: rawSeries, categories: rawCategories, height = 300, horizontal, stacked, colors, currency, yFormatter, distributed }) {
  const series = chartSafe(rawSeries);
  const categories = chartSafe(rawCategories);
  const fmt = yFormatter || (currency ? (v) => `$${Number(v).toLocaleString("en-CA", { maximumFractionDigits: 0 })}` : (v) => Number(v).toLocaleString("en-CA", { maximumFractionDigits: 1 }));
  const options = {
    ...base(height, { colors, chart: { type: "bar", stacked } }),
    plotOptions: { bar: { horizontal, borderRadius: 4, columnWidth: "55%", distributed } },
    xaxis: { categories, labels: horizontal ? { formatter: fmt } : { rotate: -30, hideOverlappingLabels: true } },
    yaxis: horizontal ? {} : { labels: { formatter: fmt } },
    legend: distributed ? { show: false } : base(height).legend,
  };
  return <ReactApexChart options={options} series={series} type="bar" height={height} />;
}

export function DonutChart({ labels: rawLabels, values, height = 280, colors, total = true, formatter }) {
  const labels = chartSafe(rawLabels);
  const options = {
    ...base(height, { colors }),
    labels,
    legend: { position: "bottom" },
    plotOptions: { pie: { donut: { size: "68%", labels: { show: total, total: { show: total, label: "Total", formatter: (w) => (formatter || ((v) => v))(w.globals.seriesTotals.reduce((a, b) => a + b, 0)) } } } } },
    stroke: { width: 2 },
  };
  return <ReactApexChart options={options} series={values} type="donut" height={height} />;
}

/** Day-of-week x hour heat map. data: [{ name:'Mon', data:[{x:'00',y:3},...] }] */
export function Heatmap({ series: rawSeries, height = 320, color = "#f95a16" }) {
  const series = chartSafe(rawSeries);
  const options = {
    ...base(height, { chart: { type: "heatmap" } }),
    colors: [color],
    plotOptions: { heatmap: { radius: 3, shadeIntensity: 0.6 } },
    legend: { show: false },
    xaxis: { type: "category" },
  };
  return <ReactApexChart options={options} series={series} type="heatmap" height={height} />;
}

/** Tiny inline trend. */
export function Sparkline({ data = [], color = PALETTE[0], height = 40, width = 110 }) {
  const options = {
    chart: { sparkline: { enabled: true }, height, width, animations: { enabled: false } },
    stroke: { curve: "smooth", width: 2 },
    colors: [color],
    tooltip: { enabled: false },
  };
  return <ReactApexChart options={options} series={[{ data }]} type="line" height={height} width={width} />;
}

/** Radial gauge 0-100. */
export function Gauge({ value = 0, label: rawLabel, height = 200, color = PALETTE[0] }) {
  const label = chartSafe(rawLabel);
  const options = {
    chart: { type: "radialBar", height },
    plotOptions: { radialBar: { hollow: { size: "62%" }, dataLabels: { name: { fontSize: "13px" }, value: { fontSize: "22px", formatter: (v) => `${Number(v).toFixed(0)}%` } } } },
    labels: [label || ""],
    colors: [color],
  };
  return <ReactApexChart options={options} series={[Math.min(100, Math.max(0, value))]} type="radialBar" height={height} />;
}
