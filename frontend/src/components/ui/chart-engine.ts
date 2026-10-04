import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, SVGRenderer]);

export function createChart(element: HTMLElement) {
  return echarts.init(element, undefined, { renderer: "svg" });
}
